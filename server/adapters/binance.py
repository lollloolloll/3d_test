"""Crypto adapter: Binance public spot market data. No API key. Truly real-time.

Sources (cadence = adapter property):
  binance_ticker  <sym>@miniTicker over WebSocket, ~1 s  -> price, 24h open (ref), 24h quote volume (energy)  [primary]
  binance_kline   <sym>@kline_1s over WebSocket, ~1 s   -> 1-second close + quote volume (correlation, bursts)

History / backfill (stored with backfill = true):
  * REST /api/v3/klines interval=1s : last ~16 min, also warms the correlation window
  * REST /api/v3/klines interval=1m : the last `backfill_days` (default 3), only the gap not yet stored
"""
from __future__ import annotations

import asyncio
import json
import time

import httpx
import websockets

from ..model import Observation
from .base import Adapter

REST = "https://api.binance.com"
WS = "wss://stream.binance.com:9443/stream?streams="


class BinanceAdapter(Adapter):
    mode = "live"
    SOURCES = [
        {"id": "binance_ticker", "label": "Binance 24h miniTicker (WS)", "cadence_s": 1, "stale_after_s": 20},
        {"id": "binance_kline", "label": "Binance kline 1s (WS) + REST history", "cadence_s": 1, "stale_after_s": 20},
    ]

    def sym(self, eid: str) -> str:
        return (eid + self.opts.get("quote", "USDT")).upper()

    async def _listed(self, cli) -> list[str]:
        eng = self.engine
        ids = self.entity_ids()
        while True:
            try:
                r = await cli.get("/api/v3/ticker/price")
                r.raise_for_status()
                listed = {x["symbol"] for x in r.json()}
                break
            except Exception as e:
                for s in ("binance_ticker", "binance_kline"):
                    eng.source_fail(s, "error", f"REST unreachable: {e!r}; retrying")
                await asyncio.sleep(10)
        live = [e for e in ids if self.sym(e) in listed]
        for e in ids:
            if e not in live:
                for s in ("binance_ticker", "binance_kline"):
                    eng.mark_missing(e, f"{self.sym(e)} not listed on Binance spot", s)
        missing = len(ids) - len(live)
        eng.set_status("universe", "warn" if missing else "ok",
                       f"{len(live)}/{len(ids)} symbols listed" + (f" ({missing} empty)" if missing else ""))
        return live

    async def _klines(self, cli, sem, e, interval, start=None, end=None, limit=1000):
        async with sem:
            out = []
            params = {"symbol": self.sym(e), "interval": interval, "limit": limit}
            if start:
                params["startTime"] = int(start)
            if end:
                params["endTime"] = int(end)
            for _ in range(20):  # paginate forward
                try:
                    r = await cli.get("/api/v3/klines", params=params)
                    r.raise_for_status()
                    rows = r.json()
                except Exception:
                    break
                out += rows
                if not start or len(rows) < limit:
                    break
                params["startTime"] = int(rows[-1][0]) + 1
            return e, out

    async def backfill_1m(self, cli, live: list[str], until: dict[str, int]) -> int:
        """1-minute klines for the part of the last `backfill_days` that is not stored yet."""
        eng = self.engine
        days = float(self.opts.get("backfill_days", 3))
        now = int(time.time() * 1000)
        sem = asyncio.Semaphore(4)
        jobs = []
        for e in live:
            have = self._stored_before.get(e)
            start = max(now - int(days * 86400_000), (have or 0) + 60_000)
            end = until.get(e, now) - 1
            if end - start >= 60_000:
                jobs.append(self._klines(cli, sem, e, "1m", start, end))
        obs = []
        for e, rows in await asyncio.gather(*jobs):
            for k in rows:  # [openTime, o, h, l, c, v, closeTime, quoteVol, ...]
                obs.append(Observation(entity=e, ts=int(k[6]) + 1, value=float(k[4]), volume=float(k[7]),
                                       source="binance_kline"))
        # explicit gap window [stored_before, first live/1s bar) -> no per-row guard (live data may be newer)
        n = await asyncio.to_thread(eng.persist_backfill, obs, False) if obs else 0
        eng.set_status("backfill", "ok", f"history: +{n:,} 1m klines stored (last {days:g} days, gaps only)")
        return n

    async def cycle(self) -> dict:
        """--collect: REST history only (1m klines for the missing part of the last N days)."""
        async with httpx.AsyncClient(base_url=REST, timeout=20, headers={"User-Agent": "market-organism/0.1"}) as cli:
            live = await self._listed(cli)
            self._stored_before = {e: self.engine.hist_max.get((e, "binance_kline")) for e in live}
            n = await self.backfill_1m(cli, live, {})
        self.engine.source_ok("binance_kline", n, f"collect: {n} 1m klines backfilled")
        return {"backfilled_1m": n}

    async def run(self):
        eng = self.engine
        async with httpx.AsyncClient(base_url=REST, timeout=20, headers={"User-Agent": "market-organism/0.1"}) as cli:
            live = await self._listed(cli)
            self._stored_before = {e: eng.hist_max.get((e, "binance_kline")) for e in live}
            # 1s klines: last ~16 min of real 1-second bars (correlation window + Hawkes baseline)
            n_boot = int(self.opts.get("bootstrap_1s_klines", 1000))
            first_1s: dict[str, int] = {}
            if n_boot > 0:
                eng.set_status("backfill", "info", f"loading {n_boot} real 1s klines per symbol…")
                sem = asyncio.Semaphore(6)
                res = await asyncio.gather(*(self._klines(cli, sem, e, "1s", limit=min(n_boot, 1000)) for e in live))
                obs = []
                for e, rows in res:
                    if rows:
                        first_1s[e] = int(rows[0][0])
                    for k in rows:
                        obs.append(Observation(entity=e, ts=int(k[6]) + 1, value=float(k[4]), volume=float(k[7]),
                                               source="binance_kline"))
                obs.sort(key=lambda o: o.ts)
                eng.ingest(obs, backfill=True)
                eng.source_ok("binance_kline", len(obs), f"{len(obs):,} 1s klines bootstrapped")
            # 24h stats (after the bootstrap so the latest value wins)
            try:
                syms = json.dumps([self.sym(e) for e in live], separators=(",", ":"))
                r = await cli.get("/api/v3/ticker/24hr", params={"symbols": syms, "type": "MINI"})
                r.raise_for_status()
                back = {self.sym(e): e for e in live}
                eng.ingest([Observation(entity=back[x["symbol"]], ts=int(x["closeTime"]), value=float(x["lastPrice"]),
                                        ref=float(x["openPrice"]), energy=float(x["quoteVolume"]), source="binance_ticker")
                            for x in r.json() if x["symbol"] in back])
            except Exception as e:
                eng.source_fail("binance_ticker", "error", f"24h ticker bootstrap failed: {e!r}")
            # 1m history for replay, in the background (live starts immediately)
            asyncio.create_task(self._bg_backfill(live, first_1s))

        streams = "/".join(f"{self.sym(e).lower()}@kline_1s/{self.sym(e).lower()}@miniTicker" for e in live)
        back = {self.sym(e): e for e in live}
        backoff = 2
        while True:
            try:
                async with websockets.connect(WS + streams, max_size=2 ** 22, ping_interval=None) as ws:
                    eng.set_status("ws", "ok", f"WebSocket connected · {len(live)} symbols")
                    backoff = 2
                    buf: list[Observation] = []
                    nk = nt = 0
                    last_flush = time.monotonic()
                    async for raw in ws:
                        d = json.loads(raw).get("data") or {}
                        ev = d.get("e")
                        if ev == "kline":
                            k = d["k"]
                            if k.get("x"):
                                buf.append(Observation(entity=back[k["s"]], ts=int(k["T"]) + 1, value=float(k["c"]),
                                                       volume=float(k["q"]), source="binance_kline"))
                                nk += 1
                        elif ev == "24hrMiniTicker":
                            buf.append(Observation(entity=back[d["s"]], ts=int(d["E"]), value=float(d["c"]),
                                                   ref=float(d["o"]), energy=float(d["q"]), source="binance_ticker"))
                            nt += 1
                        if time.monotonic() - last_flush > 0.25:
                            eng.ingest(buf)
                            if nk:
                                eng.source_ok("binance_kline", nk, "WS kline_1s streaming")
                            if nt:
                                eng.source_ok("binance_ticker", nt, "WS miniTicker streaming")
                            buf, nk, nt, last_flush = [], 0, 0, time.monotonic()
            except asyncio.CancelledError:
                raise
            except Exception as e:
                for s in ("binance_ticker", "binance_kline"):
                    eng.source_fail(s, "error", f"WebSocket dropped ({e!r}); reconnecting in {backoff}s")
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 60)

    async def _bg_backfill(self, live, first_1s):
        try:
            async with httpx.AsyncClient(base_url=REST, timeout=20, headers={"User-Agent": "market-organism/0.1"}) as cli:
                await self.backfill_1m(cli, live, first_1s)
        except Exception as e:
            self.engine.set_status("backfill", "warn", f"1m backfill failed: {e!r}")
