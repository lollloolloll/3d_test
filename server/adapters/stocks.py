"""Stock adapter: delayed polling via yfinance (Yahoo Finance, unofficial).

Labelled DELAYED on screen: Yahoo quotes can lag (often ~15 min for some exchanges) and
we poll every `poll_s` seconds (= the source cadence). Outside trading hours the organism
shows the last session.

Source `yahoo` (one per market):
  value    = close of each 5-minute bar
  volume   = dollar volume of the bar (stored; summed by the 1m/1h/1d roll-ups)
  activity = relative volume (bar dollar volume / median of the same time-of-day slot) -> burst events
  energy   = dollar volume of the latest session          -> cell size
  ref      = last close of the previous session          -> delta_ref (day change)

History: the first poll downloads `backfill_period` (default 60d, Yahoo's limit for 5m bars);
bars older than the live window are stored with backfill = true so replay works on day one.
"""
from __future__ import annotations

import asyncio
import math
import time
from datetime import datetime, timezone

from ..model import Observation
from .base import Adapter


def _download(tickers, period, interval):
    import yfinance as yf
    return yf.download(tickers, period=period, interval=interval, progress=False, group_by="ticker",
                       auto_adjust=False, threads=True, prepost=False)


class YFinanceAdapter(Adapter):
    mode = "delayed"

    def sources(self):
        poll = int(self.opts.get("poll_s", 60))
        return [{"id": "yahoo", "label": f"Yahoo Finance via yfinance (5m bars, polled every {poll}s)",
                 "cadence_s": poll, "stale_after_s": poll * 3 + 120}]

    def _parse(self, df, tick, last_emitted, now_ms, bar_ms):
        """-> (obs, got, failed, newest)"""
        eng = self.engine
        obs: list[Observation] = []
        got, newest, failed = 0, 0, []
        for e, t in tick.items():
            try:
                sub = df[t] if len(tick) > 1 else df
                sub = sub.dropna(subset=["Close"])
            except KeyError:
                sub = None
            if sub is None or sub.empty:
                failed.append(t)
                if e not in last_emitted:  # never had data -> honest empty cell
                    eng.mark_missing(e, f"{t}: no data from Yahoo", "yahoo")
                continue
            got += 1
            ts = [int(x.timestamp() * 1000) for x in sub.index]
            close = sub["Close"].to_numpy(dtype=float)
            vol = sub["Volume"].to_numpy(dtype=float)
            days = [x.date() for x in sub.index]  # exchange-local dates
            last_day = days[-1]
            prev_close = next((close[j] for j in range(len(days) - 1, -1, -1) if days[j] != last_day), None)
            sess_dv = float(sum(close[j] * vol[j] for j in range(len(days))
                                if days[j] == last_day and math.isfinite(vol[j])))
            # intraday seasonality: relative volume vs the median of the same time-of-day slot,
            # otherwise every open/close auction bar would look like a burst.
            slots = [(x.hour, x.minute) for x in sub.index]
            dv_all = [close[j] * vol[j] if math.isfinite(vol[j]) else None for j in range(len(ts))]
            prof: dict = {}
            for sl, dv in zip(slots, dv_all):
                if dv:
                    prof.setdefault(sl, []).append(dv)
            med = {k: sorted(v)[len(v) // 2] for k, v in prof.items()}
            le = last_emitted.get(e, 0)
            for j in range(len(ts)):
                end = ts[j] + bar_ms
                if end <= now_ms and end > le:
                    dv = dv_all[j]
                    m = med.get(slots[j])
                    obs.append(Observation(entity=e, ts=end, value=float(close[j]), volume=dv,
                                           activity=(dv / m) if (dv is not None and m) else None, source="yahoo"))
                    le = end
            last_emitted[e] = le
            # latest (possibly forming) bar: price + session stats, no volume event
            obs.append(Observation(entity=e, ts=min(ts[-1] + bar_ms, now_ms), value=float(close[-1]),
                                   energy=sess_dv, ref=float(prev_close) if prev_close else None, source="yahoo",
                                   extra={"session": str(last_day), "ticker": t}))
            newest = max(newest, ts[-1] + bar_ms)
        obs.sort(key=lambda o: o.ts)
        return obs, got, failed, newest

    async def _poll(self, tick, period, last_emitted, first: bool):
        eng = self.engine
        interval = self.opts.get("interval", "5m")
        bar_ms = int(self.opts.get("bar_minutes", 5)) * 60_000
        live_days = float(self.opts.get("live_days", 5))
        df = await asyncio.to_thread(_download, list(tick.values()), period, interval)
        now_ms = int(time.time() * 1000)
        obs, got, failed, newest = self._parse(df, tick, last_emitted, now_ms, bar_ms)
        n_back = 0
        if first:
            # history older than the live window -> stored only (backfill = true), not replayed into live state
            cut = now_ms - int(live_days * 86400_000)
            old = [o for o in obs if o.ts < cut and o.energy is None]
            obs = [o for o in obs if not (o.ts < cut and o.energy is None)]
            if old:
                n_back = await asyncio.to_thread(eng.persist_backfill, old)
            # the first live-window bars are also history (they happened before we started)
            hist = [o for o in obs if o.ts < now_ms - 2 * bar_ms]
            eng.ingest(hist, backfill=True)
            eng.ingest([o for o in obs if o.ts >= now_ms - 2 * bar_ms])
        else:
            eng.ingest(obs)
        return got, failed, newest, n_back

    async def cycle(self) -> dict:
        """--collect: one download of `backfill_period`, everything not yet stored is persisted."""
        eng = self.engine
        tick = {e: (eng.entities[eng.idx[e]].meta.get("ticker") or e) for e in self.entity_ids()}
        df = await asyncio.to_thread(_download, list(tick.values()), self.opts.get("backfill_period", "60d"),
                                     self.opts.get("interval", "5m"))
        obs, got, failed, _ = self._parse(df, tick, {}, int(time.time() * 1000),
                                          int(self.opts.get("bar_minutes", 5)) * 60_000)
        n = await asyncio.to_thread(eng.persist_backfill, [o for o in obs if o.energy is None])
        if got:
            eng.source_ok("yahoo", got, f"collect: {got}/{len(tick)} tickers, +{n} bars")
        else:
            eng.source_fail("yahoo", "error", "collect: no data from Yahoo")
        return {"tickers": got, "failed": failed[:10], "stored_bars": n}

    async def run(self):
        eng = self.engine
        tick = {e: (eng.entities[eng.idx[e]].meta.get("ticker") or e) for e in self.entity_ids()}
        poll_s = int(self.opts.get("poll_s", 60))
        last_emitted: dict[str, int] = {}
        first = True
        while True:
            t0 = time.time()
            try:
                period = self.opts.get("backfill_period", "60d") if first else self.opts.get("period", "5d")
                got, failed, newest, n_back = await self._poll(tick, period, last_emitted, first)
                if first and n_back:
                    eng.set_status("backfill", "ok", f"history: +{n_back:,} 5m bars stored ({period}, backfill)")
                first = False
                age_min = (time.time() * 1000 - newest) / 60000 if newest else None
                if age_min is not None and age_min > 20:
                    when = datetime.fromtimestamp(newest / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
                    eng.set_status("market", "info", f"market closed / no new bars — showing last session (latest bar ends {when})")
                else:
                    eng.set_status("market", "ok", "market open — 5m bars, delayed")
                msg = f"{got}/{len(tick)} tickers" + (f" · failed this poll: {', '.join(failed[:6])}" if failed else "")
                if got:
                    eng.source_ok("yahoo", got, msg)
                else:
                    eng.source_fail("yahoo", "error", "poll returned no data — showing previous poll")
            except Exception as ex:
                eng.source_fail("yahoo", "error", f"yfinance poll failed: {ex!r}; retrying")
            await asyncio.sleep(max(5, poll_s - (time.time() - t0)))
