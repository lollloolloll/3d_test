"""One-command launcher.

    python run.py                         # crypto (live) + US stocks + KOSPI (delayed) + Kidak (daily)
    python run.py --sim                   # also the SIMULATED scale-test market
    python run.py --markets crypto        # only some markets
    python run.py --no-browser --port 8790
    python run.py --collect kidak         # collect-only: one pass, store to data/history.duckdb, exit (Task Scheduler)

First run creates .venv/ next to this file and installs requirements.txt into it.
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VENV = ROOT / ".venv"
VPY = VENV / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
DEFAULT_MARKETS = "crypto,stocks_us,stocks_kr,kidak"


def ensure_env():
    """Re-exec inside the local venv, creating it and installing deps on first run."""
    if Path(sys.prefix).resolve() == VENV.resolve():
        return
    if not VPY.exists():
        print("[setup] creating .venv …", flush=True)
        subprocess.check_call([sys.executable, "-m", "venv", str(VENV)])
    try:
        subprocess.check_call([str(VPY), "-c", "import fastapi, uvicorn, duckdb, websockets, httpx, numpy, yfinance"],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except subprocess.CalledProcessError:
        print("[setup] installing requirements …", flush=True)
        subprocess.check_call([str(VPY), "-m", "pip", "install", "-q", "-r", str(ROOT / "requirements.txt")])
    # re-run this script with the venv interpreter (subprocess, because execv is unreliable on Windows)
    try:
        sys.exit(subprocess.call([str(VPY), str(Path(__file__).resolve()), *sys.argv[1:]]))
    except KeyboardInterrupt:
        sys.exit(0)


def find_chrome() -> str | None:
    cands = [os.environ.get("CHROME"),
             r"C:\Program Files\Google\Chrome\Application\chrome.exe",
             r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
             os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
             "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
             shutil.which("google-chrome") or "", shutil.which("chromium") or ""]
    return next((c for c in cands if c and Path(c).exists()), None)


def free_port(host: str, start: int) -> int:
    import socket
    for p in range(start, start + 50):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind((host, p))
                return p
            except OSError:
                continue
    raise SystemExit(f"no free port in {start}..{start + 49}")


def open_browser(url: str):
    time.sleep(2.0)
    chrome = find_chrome()
    if chrome:
        subprocess.Popen([chrome, url])
    else:
        webbrowser.open(url)


def main():
    ap = argparse.ArgumentParser(description="Market Organism — live market visualization")
    ap.add_argument("--markets", default=DEFAULT_MARKETS, help=f"comma list of configs/*.json ids (default {DEFAULT_MARKETS})")
    ap.add_argument("--sim", action="store_true", help="also run the SIMULATED scale-test market")
    ap.add_argument("--sim-n", type=int, default=0, help="number of simulated entities (default 720)")
    ap.add_argument("--port", type=int, default=8790)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--collect", metavar="MARKETS", help="collect-only mode: run one collection pass for these markets "
                    "(e.g. kidak), append to data/history.duckdb and exit — no UI. For Windows Task Scheduler.")
    a = ap.parse_args()
    ensure_env()

    import logging
    import uvicorn

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    for noisy in ("yfinance", "peewee", "httpx", "websockets"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    markets = [m.strip() for m in a.markets.split(",") if m.strip()]
    if a.sim and "sim" not in markets:
        markets.append("sim")
    if a.sim_n:
        os.environ["ORGANISM_SIM_N"] = str(a.sim_n)
    sys.path.insert(0, str(ROOT))
    if a.collect:
        import asyncio
        from server.app import collect
        sys.exit(asyncio.run(collect([m.strip() for m in a.collect.split(",") if m.strip()])))
    from server.app import create_app

    app = create_app(markets)
    port = free_port(a.host, a.port)
    if port != a.port:
        print(f"[run] port {a.port} is busy, using {port}", flush=True)
    a.port = port
    url = f"http://{a.host}:{a.port}/?market={markets[0]}"
    print(f"\n  Market Organism -> {url}\n  markets: {', '.join(markets)}\n", flush=True)
    if not a.no_browser:
        threading.Thread(target=open_browser, args=(url,), daemon=True).start()
    uvicorn.run(app, host=a.host, port=a.port, log_level="warning")


if __name__ == "__main__":
    main()
