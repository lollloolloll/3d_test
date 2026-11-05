"""Export a static, server-less copy of the organism (GitHub Pages or any static host).

    python run.py                      # in another terminal: the live server
    python tools/export_static.py      # -> site/  (web app + recorded data)

The exported page never claims to be live: the badge reads SNAPSHOT, sources read "Recorded <time>",
and the timeline plays the stored history as a REPLAY. Simulated markets are not exported.
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
FRAMES = {"1m": 2880, "1h": 2200, "1d": 1500}   # buckets per grain kept in the export


def main(a) -> int:
    out = (ROOT / a.out).resolve()
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(ROOT / "web", out)
    c = httpx.Client(base_url=a.base, timeout=120)
    markets = [m for m in c.get("/api/markets").json() if m.get("mode") != "simulated"]
    if a.markets:
        keep = a.markets.split(",")
        markets = [m for m in markets if m["id"] in keep]
    (out / "data").mkdir()
    sizes = {}
    for m in markets:
        mid = m["id"]
        d = out / "data" / mid
        d.mkdir()
        snap = c.get(f"/api/snapshot/{mid}").json()
        (d / "snapshot.json").write_text(json.dumps(snap, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
        info = c.get(f"/api/replay/{mid}", params={"max_frames": 1}).json()
        (d / "replay_info.json").write_text(json.dumps(info, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
        for g in info.get("grains", []) if info.get("available") else []:
            r = c.get(f"/api/replay/{mid}", params={"grain": g, "max_frames": FRAMES.get(g, 1500)}).json()
            (d / f"replay_{g}.json").write_text(json.dumps(r, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
        sizes[mid] = sum(p.stat().st_size for p in d.iterdir())
        print(f"  {mid:10s} {len(snap.get('entities', [])):4d} entities · replay {','.join(info.get('grains', [])) or '—'} · {sizes[mid] / 1e6:.1f} MB")
    (out / "data" / "markets.json").write_text(json.dumps(markets, ensure_ascii=False), encoding="utf-8")
    (out / "static.json").write_text(json.dumps({"exported_at": int(time.time() * 1000), "markets": [m["id"] for m in markets],
                                                 "note": "static export: recorded snapshot + stored history replay, not live"}), encoding="utf-8")
    (out / ".nojekyll").write_text("")
    total = sum(p.stat().st_size for p in out.rglob("*") if p.is_file())
    print(f"exported {len(markets)} markets -> {out} ({total / 1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8790")
    ap.add_argument("--out", default="site")
    ap.add_argument("--markets", default="", help="comma list; default = every non-simulated market")
    sys.exit(main(ap.parse_args()))
