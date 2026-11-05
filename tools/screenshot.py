"""Headless-Chrome screenshot + self-check of the running organism (via the DevTools protocol).

    python tools/screenshot.py --url http://127.0.0.1:8790/?market=crypto --out screenshots/crypto.png --wait 20

Prints the page's own live stats (fps, cells, vessels, data age, badge text) so a screenshot
is never the only evidence. Requires Chrome; set CHROME=... if it is not in the default path.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx
import websockets

CHROME = os.environ.get("CHROME", r"C:\Program Files\Google\Chrome\Application\chrome.exe")

STATS_JS = """(() => { const S = window.__organism; if (!S || !S.meta) return null;
  return { market: S.market, mode: S.meta.mode, badge: document.getElementById('badgeText').textContent,
    clock: document.getElementById('clock').innerText, fps: Math.round(S.fps), cells: S.ents.length,
    live_cells: S.ents.filter(e => !e.s.m).length, empty_cells: S.ents.filter(e => e.s.m).map(e => e.id + ': ' + e.s.m),
    edges: S.edges.length, sector_edges: S.sedges.length, msgs: S.msgs, n_obs: S.nObs,
    data_age_s: S.dataTs ? (Date.now() - S.dataTs) / 1000 : null,
    status: (S.status || []).map(s => s.level + ': ' + s.msg),
    phases: Object.entries(S.secState).filter(([k, v]) => v.phase).map(([k]) => k),
    sources: (S.sources || []).map(s => `${s.id}: ${s.state} · last_ok ${s.last_ok ? ((Date.now() - s.last_ok) / 1000).toFixed(1) + 's ago' : '—'} · ${s.msg || ''}`),
    stale_chip: !document.getElementById('stale').hidden ? document.getElementById('stale').textContent : null,
    coverage: S.ents.slice(0, 6).map(e => e.id + ' ' + (e.s.sc || []).join('/')),
    replay: window.__replayState && window.__replayState.on ? { T: new Date(window.__replayState.T).toISOString(), grain: window.__replayState.data && window.__replayState.data.grain,
      speed: window.__replayState.speed, rows: window.__replayState.data && window.__replayState.data.n_rows, bigtime: document.getElementById('btT').textContent, badge: document.getElementById('btR').textContent } : null,
    timeline: document.getElementById('tlinfo').textContent,
    sample: S.ents.slice(0, 3).map(e => ({ id: e.id, v: e.s.v, dr: e.s.dr, dw: e.s.dw, b: e.s.b, ts: e.s.ts })) }; })()"""


async def cdp(ws, msg_id, method, params=None):
    await ws.send(json.dumps({"id": msg_id, "method": method, "params": params or {}}))
    while True:
        m = json.loads(await ws.recv())
        if m.get("id") == msg_id:
            if "error" in m:
                raise RuntimeError(m["error"])
            return m.get("result", {})


async def main(a):
    port = 9333
    prof = tempfile.mkdtemp(prefix="mo-chrome-")
    proc = subprocess.Popen([CHROME, "--headless=new", f"--remote-debugging-port={port}", f"--user-data-dir={prof}",
                             f"--window-size={a.width},{a.height}", "--hide-scrollbars", "--no-first-run",
                             "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
                             "about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        ver = None
        for _ in range(50):
            try:
                ver = httpx.get(f"http://127.0.0.1:{port}/json/list", timeout=1).json()
                if ver:
                    break
            except Exception:
                time.sleep(0.2)
        page = next(t for t in ver if t["type"] == "page")
        async with websockets.connect(page["webSocketDebuggerUrl"], max_size=2 ** 26) as ws:
            i = 0

            async def call(m, p=None):
                nonlocal i
                i += 1
                return await asyncio.wait_for(cdp(ws, i, m, p), timeout=a.timeout)

            await call("Emulation.setDeviceMetricsOverride", {"width": a.width, "height": a.height, "deviceScaleFactor": 1, "mobile": False})
            await call("Page.enable")
            await call("Page.navigate", {"url": a.url})
            stats = []
            for k in range(a.samples):
                await asyncio.sleep(a.wait / a.samples)
                r = await call("Runtime.evaluate", {"expression": STATS_JS, "returnByValue": True})
                stats.append(r.get("result", {}).get("value"))
            if a.js:
                await call("Runtime.evaluate", {"expression": a.js, "returnByValue": True})
                await asyncio.sleep(a.after_js)
                r = await call("Runtime.evaluate", {"expression": STATS_JS, "returnByValue": True})
                stats.append(r.get("result", {}).get("value"))
            shot = await call("Page.captureScreenshot", {"format": "png"})
            out = Path(a.out)
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(base64.b64decode(shot["data"]))
            rep = json.dumps({"screenshot": str(out.resolve()), "url": a.url, "samples": stats}, ensure_ascii=False, indent=1)
            out.with_suffix(".json").write_text(rep, encoding="utf-8")  # evidence next to the image
            print(rep)
    finally:
        proc.terminate()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--wait", type=float, default=15)
    ap.add_argument("--samples", type=int, default=2)
    ap.add_argument("--width", type=int, default=1600)
    ap.add_argument("--height", type=int, default=1000)
    ap.add_argument("--js", default="", help="JS to run before the final capture (e.g. zoom)")
    ap.add_argument("--after-js", type=float, default=3)
    ap.add_argument("--timeout", type=float, default=90, help="per-CDP-call timeout (software GL can be slow)")
    sys.exit(asyncio.run(main(ap.parse_args())))
