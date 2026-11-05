"""FastAPI app: runs every enabled market (engine + adapter) and streams roll-ups/diffs over SSE.

Endpoints
  GET /                         frontend
  GET /api/markets              list of markets + provenance mode
  GET /api/stream/{market}      SSE: `snapshot` then `diff` (≈1/s), `edges` (every N s)
  GET /api/rollup/{market}?minutes=15   DuckDB time-window roll-up (entities + sectors)
  GET /api/history/{market}/{entity}?grain=1m|1h|1d|raw   DuckDB history
  GET /api/replay/{market}?grain=1h&from=&to=  stored history as columnar frames for the time-lapse
  GET /api/stats                 what is stored (rows per market/source, backfill flag, time span)

History lives in data/history.duckdb (every sample appended, plus 1m/1h/1d roll-ups).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .adapters import REGISTRY
from .engine import MarketEngine
from .store import GRAIN_S, Store, StoreLocked

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
log = logging.getLogger("app")


def expand_generated(cfg: dict) -> dict:
    """Simulated configs may declare `generate: {sectors, per_sector}` instead of listing entities."""
    g = cfg.get("generate")
    if not g:
        return cfg
    n_total = int(os.environ.get("ORGANISM_SIM_N", 0)) or g.get("sectors", 10) * g.get("per_sector", 40)
    S = g.get("sectors", 10)
    per = max(1, n_total // S)
    names = g.get("sector_names") or [f"Cluster {chr(65 + i)}" for i in range(S)]
    cfg = dict(cfg)
    cfg["sectors"] = [{"id": f"c{i}", "label": names[i % len(names)],
                       "entities": [{"id": f"c{i}-{j:04d}", "label": f"{chr(65 + i)}{j}"} for j in range(per)]}
                      for i in range(S)]
    return cfg


def load_configs(names: list[str]) -> list[dict]:
    out = []
    for n in names:
        p = ROOT / "configs" / f"{n}.json"
        cfg = json.loads(p.read_text(encoding="utf-8"))
        out.append(expand_generated(cfg))
    return out


DB_PATH = ROOT / "data" / "history.duckdb"


def build_engines(market_names: list[str], store):
    engines: dict[str, MarketEngine] = {}
    for cfg in load_configs(market_names):
        # simulated / persist=false markets never touch the history file (not even the source log)
        eng = MarketEngine(cfg, store if cfg.get("engine", {}).get("persist", True) else None)
        cls = REGISTRY[cfg["adapter"]]
        if cls.mode != cfg.get("mode"):
            raise ValueError(f"{cfg['id']}: config mode {cfg.get('mode')!r} != adapter mode {cls.mode!r}")
        eng.adapter = cls(cfg, eng)
        eng.set_sources(eng.adapter.sources())
        engines[cfg["id"]] = eng
    return engines


async def collect(market_names: list[str], wait_lock_s: float = 120) -> int:
    """`run.py --collect`: one collection pass per market (fetch + backfill), flush, print, exit.
    Exit codes: 0 ok · 2 a market failed · 3 history file locked by another process."""
    try:
        store = Store(DB_PATH, wait_lock_s=wait_lock_s)
    except StoreLocked as e:
        print(f"[collect] {e}", flush=True)
        return 3
    rc = 0
    try:
        engines = build_engines(market_names, store)
        for eng in engines.values():
            await asyncio.to_thread(eng.warm_from_history)
            try:
                res = await eng.adapter.cycle()
            except Exception as ex:
                log.exception("[%s] collect failed", eng.id)
                res, rc = {"error": repr(ex)}, 2
            eng.flush()
            src = {s["id"]: f"{s['state']}" + (f" ({s['msg']})" if s.get("msg") else "") for s in eng.sources_public()}
            print(f"[collect] {eng.id}: {json.dumps(res, ensure_ascii=False)}", flush=True)
            for k, v in src.items():
                print(f"          {k:18s} {v}", flush=True)
        st = store.stats()
        for row in st["samples"]:
            if row["market"] in engines:
                print(f"[stored]  {row['market']:9s} {row['source']:18s} backfill={str(row['backfill']):5s} rows={row['rows']:>9,}", flush=True)
    finally:
        store.close()
    return rc


class Runtime:
    def __init__(self, market_names: list[str]):
        self.store_error = None
        self.store = None
        needs_store = any(c.get("engine", {}).get("persist", True) for c in load_configs(market_names))
        try:
            if needs_store:   # a simulated-only run never opens the history file
                self.store = Store(DB_PATH)
        except StoreLocked as e:
            # another process (e.g. a scheduled --collect) holds the file: run, but say so on screen
            self.store, self.store_error = None, str(e)
            log.error("history disabled: %s", e)
        self.engines: dict[str, MarketEngine] = {}
        self.order: list[str] = []
        self.tasks: list[asyncio.Task] = []
        self.engines = build_engines(market_names, self.store)
        self.order = list(self.engines)
        for eng in self.engines.values():
            if self.store_error:
                eng.set_status("history", "error", f"history NOT recorded this run — {self.store_error}")

    async def start(self):
        for eng in self.engines.values():
            try:
                info = await asyncio.to_thread(eng.warm_from_history)
                if info:
                    eng.set_status("history", "ok", f"warm start from history: {info.get('latest_rows', 0)} latest samples, "
                                                    f"{info.get('series_rows', 0)} series points, {info.get('events', 0)} events")
            except Exception:
                log.exception("[%s] warm start failed", eng.id)
            for coro in (eng.adapter.run(), eng.emit_loop(), eng.edges_loop(), eng.flush_loop()):
                self.tasks.append(asyncio.create_task(self._guard(eng.id, coro)))

    async def _guard(self, mid, coro):
        try:
            await coro
        except asyncio.CancelledError:
            pass
        except Exception:
            log.exception("[%s] task crashed", mid)
            self.engines[mid].set_status("runtime", "error", "adapter task crashed — see server log")

    async def stop(self):
        for t in self.tasks:
            t.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        for eng in self.engines.values():
            try:
                eng.flush()
            except Exception:
                pass
        if self.store is not None:
            self.store.close()


def create_app(market_names: list[str]) -> FastAPI:
    rt = Runtime(market_names)

    @asynccontextmanager
    async def lifespan(app):
        await rt.start()
        yield
        await rt.stop()

    app = FastAPI(title="Market Organism", lifespan=lifespan)
    app.state.rt = rt

    @app.get("/api/markets")
    def markets():
        return [{"id": m, "title": rt.engines[m].cfg.get("title", m), "mode": rt.engines[m].cfg.get("mode"),
                 "n": len(rt.engines[m].entities), "history": rt.store is not None, "history_error": rt.store_error}
                for m in rt.order]

    def eng_or_404(m):
        if m not in rt.engines:
            raise HTTPException(404, f"unknown market {m}")
        return rt.engines[m]

    @app.get("/api/stream/{market}")
    async def stream(market: str, request: Request):
        eng = eng_or_404(market)
        q = eng.subscribe()

        async def gen():
            try:
                snap = json.dumps(eng.snapshot(), separators=(",", ":"), ensure_ascii=False)
                yield f"event: message\ndata: {snap}\n\n"
                while True:
                    if await request.is_disconnected():
                        break
                    try:
                        data = await asyncio.wait_for(q.get(), timeout=15)
                        yield f"data: {data}\n\n"
                    except asyncio.TimeoutError:
                        yield ": keep-alive\n\n"
            finally:
                eng.unsubscribe(q)

        return StreamingResponse(gen(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    @app.get("/api/snapshot/{market}")
    def snapshot(market: str):
        return JSONResponse(eng_or_404(market).snapshot())

    def store_or_503():
        if rt.store is None:
            raise HTTPException(503, f"history disabled: {rt.store_error}")
        return rt.store

    @app.get("/api/rollup/{market}")
    async def rollup(market: str, minutes: float = 15):
        eng_or_404(market)
        return await asyncio.to_thread(store_or_503().rollup, market, minutes)

    @app.get("/api/history/{market}/{entity}")
    async def history(market: str, entity: str, grain: str = "1m", limit: int = 500):
        eng_or_404(market)
        if grain not in ("raw", *GRAIN_S):
            raise HTTPException(400, "grain must be raw|1m|1h|1d")
        return await asyncio.to_thread(store_or_503().history, market, entity, grain, min(limit, 20000))

    @app.get("/api/stats")
    async def stats():
        return await asyncio.to_thread(store_or_503().stats)

    @app.get("/api/replay/{market}")
    async def replay(market: str, grain: str | None = None, frm: int | None = None, to: int | None = None,
                     max_frames: int = 4000):
        """Stored history for the time-lapse, as columnar arrays (the client interpolates and draws it
        through the same render path as live). Without from/to: the last `max_frames` buckets."""
        eng = eng_or_404(market)
        rc = eng.cfg.get("replay") or {}
        if rc.get("disabled") or not rc.get("source"):
            return {"available": False, "reason": rc.get("disabled") or "no replay source configured"}
        st = store_or_503()
        src = rc["source"]
        rng = await asyncio.to_thread(st.replay_range, market, src)
        grains = [g for g in (rc.get("grains") or list(GRAIN_S)) if g in rng]
        if not grains:
            return {"available": False, "reason": f"no stored history for source {src} yet", "range": rng}
        grain = grain if grain in grains else grains[0]
        to = to or rng[grain]["to"]
        frm = frm or max(rng[grain]["from"], to - max_frames * GRAIN_S[grain] * 1000)
        rows = await asyncio.to_thread(st.replay, market, [src], grain, frm, to)
        idx = {e: i for i, e in enumerate(eng.ids)}
        tset = sorted({r[2] for r in rows})
        tix = {t: i for i, t in enumerate(tset)}
        vm, em = rc.get("value", "close"), rc.get("energy", "volume")
        cols = {"e": [], "t": [], "v": [], "x": []}
        for ent, _src, t, close, mean, vol, energy, n in rows:
            i = idx.get(ent)
            v = mean if vm == "mean" else close
            if i is None or v is None:
                continue
            cols["e"].append(i)
            cols["t"].append(tix[t])
            cols["v"].append(round(v, 8))
            cols["x"].append(n if em == "count" else (vol if vol is not None else energy))
        return {"available": True, "source": src, "grain": grain, "grains": grains, "range": rng,
                "value": vm, "energy": em, "note": rc.get("note", ""), "from": frm, "to": to,
                "times": tset, "cols": cols, "n_rows": len(cols["e"])}

    @app.get("/")
    def index(request: Request):
        q = request.url.query
        return RedirectResponse("/web/" + (f"?{q}" if q else ""))

    @app.middleware("http")
    async def no_cache_web(request: Request, call_next):
        resp = await call_next(request)
        if request.url.path.startswith("/web/") and not request.url.path.startswith("/web/vendor/"):
            resp.headers["Cache-Control"] = "no-cache"
        return resp

    app.mount("/web", StaticFiles(directory=WEB, html=True), name="web")
    return app
