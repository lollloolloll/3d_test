"""DuckDB history (data/history.duckdb): every ingested sample is appended from the first run on.

Tables (timestamps are UTC):
  samples     raw observations: market, entity, source, ts, value, volume, energy, ref, delta, extra, backfill
  rollups     1m / 1h / 1d: OHLC, mean (vsum/vn), volume, last energy, n — cascaded samples → 1m → 1h → 1d
  events      point events for the Hawkes kernels (detected bursts, review arrivals)
  snapshots   one row per (market, entity, UTC day) for slow sources (App Store lookup)
  source_log  every source fetch outcome (ok / error / skip) → freshness survives restarts
  entities    market → sector → entity mapping (SQL roll-ups by sector)

The engine keeps only the hot rolling window in memory and warms from here on start-up.
`backfill = true` marks history fetched after the fact (REST klines, yfinance history, RSS pages,
DataLab date ranges), as opposed to samples observed live.
"""
from __future__ import annotations

import json
import logging
import threading
import time
from datetime import date, datetime, timezone
from pathlib import Path

import duckdb
import pandas as pd

log = logging.getLogger("store")

SCHEMA = """
CREATE TABLE IF NOT EXISTS samples (
  market VARCHAR, entity VARCHAR, source VARCHAR, ts TIMESTAMPTZ,
  value DOUBLE, volume DOUBLE, energy DOUBLE, ref DOUBLE, delta DOUBLE, extra JSON, backfill BOOLEAN);
CREATE TABLE IF NOT EXISTS rollups (
  market VARCHAR, entity VARCHAR, source VARCHAR, grain VARCHAR, bucket_ts TIMESTAMPTZ,
  open DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE, vsum DOUBLE, vn BIGINT,
  volume DOUBLE, energy DOUBLE, n BIGINT,
  PRIMARY KEY (market, entity, source, grain, bucket_ts));
CREATE TABLE IF NOT EXISTS events (
  market VARCHAR, entity VARCHAR, ts TIMESTAMPTZ, mark DOUBLE, PRIMARY KEY (market, entity, ts));
CREATE TABLE IF NOT EXISTS snapshots (
  market VARCHAR, entity VARCHAR, day DATE, value DOUBLE, energy DOUBLE, extra JSON,
  PRIMARY KEY (market, entity, day));
CREATE TABLE IF NOT EXISTS source_log (
  market VARCHAR, source VARCHAR, ts TIMESTAMPTZ, state VARCHAR, n BIGINT, msg VARCHAR);
CREATE TABLE IF NOT EXISTS entities (
  market VARCHAR, entity VARCHAR, sector VARCHAR, label VARCHAR, PRIMARY KEY (market, entity));
"""

GRAINS = (("1m", "1 minute"), ("1h", "1 hour"), ("1d", "1 day"))
GRAIN_S = {"1m": 60, "1h": 3600, "1d": 86400}


class StoreLocked(RuntimeError):
    pass


def _dt(ms: float) -> datetime:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc)


class Store:
    def __init__(self, path: Path, wait_lock_s: float = 0):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self.lock = threading.Lock()
        t0 = time.time()
        while True:
            try:
                self.con = duckdb.connect(str(path))
                break
            except duckdb.IOException as e:
                if time.time() - t0 >= wait_lock_s:
                    raise StoreLocked(f"{path.name} is locked by another process ({e})") from e
                time.sleep(2)
        self.con.execute("SET TimeZone = 'UTC'")
        self.con.execute(SCHEMA)

    # ------------------------------------------------------------------ writes
    def register_entities(self, market: str, rows: list[tuple[str, str, str]]):
        with self.lock:
            self.con.execute("DELETE FROM entities WHERE market = ?", [market])
            if rows:
                df = pd.DataFrame(rows, columns=["entity", "sector", "label"])
                df.insert(0, "market", market)
                self.con.register("_ents", df)
                self.con.execute("INSERT INTO entities SELECT market, entity, sector, label FROM _ents")
                self.con.unregister("_ents")

    def append_samples(self, market: str, rows: list[tuple]) -> int:
        """rows: (entity, source, ts_ms, value, volume, energy, ref, delta, extra_json, backfill)"""
        if not rows:
            return 0
        df = pd.DataFrame(rows, columns=["entity", "source", "ts_ms", "value", "volume", "energy", "ref", "delta",
                                         "extra", "backfill"])
        df["ts"] = pd.to_datetime(df["ts_ms"], unit="ms", utc=True)
        df.insert(0, "market", market)
        with self.lock:
            self.con.register("_s", df)
            self.con.execute("INSERT INTO samples SELECT market, entity, source, ts, value, volume, energy, ref, delta, "
                             "extra::JSON, backfill FROM _s")
            self.con.unregister("_s")
        return len(df)

    def update_rollups(self, market: str, since_ms: int):
        """Recompute the 1m/1h/1d buckets touched since `since_ms` (cascade samples → 1m → 1h → 1d)."""
        since = _dt(since_ms)
        with self.lock:
            self.con.execute("""
                INSERT OR REPLACE INTO rollups
                SELECT market, entity, source, '1m', time_bucket(INTERVAL 1 minute, ts) AS b,
                       arg_min(value, ts) FILTER (WHERE value IS NOT NULL), max(value), min(value),
                       arg_max(value, ts) FILTER (WHERE value IS NOT NULL), sum(value), count(value),
                       sum(volume), arg_max(energy, ts) FILTER (WHERE energy IS NOT NULL), count(*)
                FROM samples WHERE market = ? AND ts >= time_bucket(INTERVAL 1 minute, ?::TIMESTAMPTZ)
                GROUP BY ALL""", [market, since])
            for (g, interval), (src, _) in zip(GRAINS[1:], GRAINS[:-1]):
                self.con.execute(f"""
                    INSERT OR REPLACE INTO rollups
                    SELECT market, entity, source, '{g}', time_bucket(INTERVAL {interval}, bucket_ts) AS b,
                           arg_min(open, bucket_ts) FILTER (WHERE open IS NOT NULL), max(high), min(low),
                           arg_max(close, bucket_ts) FILTER (WHERE close IS NOT NULL), sum(vsum), sum(vn),
                           sum(volume), arg_max(energy, bucket_ts) FILTER (WHERE energy IS NOT NULL), sum(n)
                    FROM rollups WHERE market = ? AND grain = '{src}'
                      AND bucket_ts >= time_bucket(INTERVAL {interval}, ?::TIMESTAMPTZ)
                    GROUP BY ALL""", [market, since])

    def prune_raw(self, market: str, keep_days: float):
        """Raw samples may be pruned for high-rate sources; roll-ups are kept forever."""
        with self.lock:
            self.con.execute("DELETE FROM samples WHERE market = ? AND ts < now() - (? * INTERVAL 1 DAY)",
                             [market, keep_days])

    def append_events(self, market: str, rows: list[tuple[str, int, float]]):
        if not rows:
            return
        df = pd.DataFrame(rows, columns=["entity", "ts_ms", "mark"]).drop_duplicates(["entity", "ts_ms"], keep="last")
        df["ts"] = pd.to_datetime(df["ts_ms"], unit="ms", utc=True)
        df.insert(0, "market", market)
        with self.lock:
            self.con.register("_ev", df)
            self.con.execute("INSERT OR REPLACE INTO events SELECT market, entity, ts, mark FROM _ev")
            self.con.unregister("_ev")

    def log_source(self, market: str, source: str, ts_ms: int, state: str, n: int, msg: str):
        with self.lock:
            self.con.execute("INSERT INTO source_log VALUES (?, ?, ?, ?, ?, ?)",
                             [market, source, _dt(ts_ms), state, n, msg])

    def upsert_snapshot(self, market: str, entity: str, day: date, value, energy, extra: dict):
        with self.lock:
            self.con.execute("INSERT OR REPLACE INTO snapshots VALUES (?, ?, ?, ?, ?, ?)",
                             [market, entity, day, value, energy, json.dumps(extra, ensure_ascii=False)])

    def previous_snapshot(self, market: str, entity: str, before: date):
        with self.lock:
            return self.con.execute(
                "SELECT day, value, energy FROM snapshots WHERE market=? AND entity=? AND day < ? "
                "ORDER BY day DESC LIMIT 1", [market, entity, before]).fetchone()

    # ------------------------------------------------------------------ warm start
    def source_last(self, market: str) -> dict[str, dict]:
        with self.lock:
            rows = self.con.execute("""
                SELECT source, epoch_ms(max(ts) FILTER (WHERE state = 'ok')), epoch_ms(max(ts)),
                       arg_max(state, ts), arg_max(msg, ts)
                FROM source_log WHERE market = ? GROUP BY source""", [market]).fetchall()
        return {r[0]: {"last_ok": r[1], "last_attempt": r[2], "state": r[3], "msg": r[4]} for r in rows}

    def latest_samples(self, market: str, since_ms: int) -> list[tuple]:
        """Latest non-null fields per (entity, source) since `since_ms`."""
        with self.lock:
            return self.con.execute("""
                SELECT entity, source, epoch_ms(max(ts)),
                       arg_max(value, ts) FILTER (WHERE value IS NOT NULL),
                       arg_max(energy, ts) FILTER (WHERE energy IS NOT NULL),
                       arg_max(ref, ts) FILTER (WHERE ref IS NOT NULL),
                       arg_max(delta, ts) FILTER (WHERE delta IS NOT NULL),
                       arg_max(extra, ts) FILTER (WHERE extra IS NOT NULL)
                FROM samples WHERE market = ? AND ts >= ? GROUP BY entity, source""", [market, _dt(since_ms)]).fetchall()

    def max_ts(self, market: str, source: str | None = None) -> dict:
        with self.lock:
            if source:
                rows = self.con.execute("SELECT entity, source, epoch_ms(max(ts)) FROM samples WHERE market=? AND source=? "
                                        "GROUP BY entity, source", [market, source]).fetchall()
            else:
                rows = self.con.execute("SELECT entity, source, epoch_ms(max(ts)) FROM samples WHERE market=? "
                                        "GROUP BY entity, source", [market]).fetchall()
        return {(r[0], r[1]): r[2] for r in rows}

    def series(self, market: str, source: str, bucket_s: float, since_ms: int) -> list[tuple[str, int, float]]:
        """Close per bucket for warming the correlation window (roll-ups when the bucket is ≥ 1 minute)."""
        grain = "1d" if bucket_s >= 86400 else "1h" if bucket_s >= 3600 else "1m" if bucket_s >= 60 else None
        with self.lock:
            if grain:
                return self.con.execute(
                    "SELECT entity, epoch_ms(bucket_ts) + ?, close FROM rollups WHERE market=? AND source=? AND grain=? "
                    "AND bucket_ts >= ? AND close IS NOT NULL ORDER BY bucket_ts",
                    [GRAIN_S[grain] * 1000 - 1, market, source, grain, _dt(since_ms)]).fetchall()
            return self.con.execute(
                "SELECT entity, epoch_ms(ts), value FROM samples WHERE market=? AND source=? AND ts >= ? "
                "AND value IS NOT NULL ORDER BY ts", [market, source, _dt(since_ms)]).fetchall()

    def recent_events(self, market: str, since_ms: int) -> list[tuple[str, int, float]]:
        with self.lock:
            return self.con.execute("SELECT entity, epoch_ms(ts), mark FROM events WHERE market=? AND ts >= ? "
                                    "ORDER BY ts", [market, _dt(since_ms)]).fetchall()

    # ------------------------------------------------------------------ replay
    def replay_range(self, market: str, source: str | None = None) -> dict:
        """Per grain: replay span and row count. `from` is the median of the per-entity first buckets, so one
        entity with a much older history (e.g. a halted symbol, an app with 2014 reviews) does not stretch the
        timeline into a period where almost nothing else has data; `first` keeps the true earliest bucket."""
        q = ("SELECT grain, epoch_ms(median(f)), epoch_ms(max(l)), sum(n), count(*), epoch_ms(min(f)) FROM ("
             " SELECT grain, entity, min(bucket_ts) f, max(bucket_ts) l, count(*) n FROM rollups WHERE market=?"
             + (" AND source=?" if source else "") + " GROUP BY grain, entity) GROUP BY grain")
        with self.lock:
            rows = self.con.execute(q, [market] + ([source] if source else [])).fetchall()
        return {g: {"from": int(a), "to": b, "rows": int(n), "entities": ne, "first": f} for g, a, b, n, ne, f in rows}

    def replay(self, market: str, sources: list[str], grain: str, from_ms: int, to_ms: int, max_rows: int = 400_000):
        """Columnar frames for the client-side replay: one row per (entity, bucket)."""
        with self.lock:
            rows = self.con.execute(f"""
                SELECT entity, source, epoch_ms(bucket_ts), close, vsum / NULLIF(vn, 0), volume, energy, n
                FROM rollups WHERE market=? AND grain=? AND source IN ({','.join('?' * len(sources))})
                  AND bucket_ts BETWEEN ? AND ? ORDER BY bucket_ts LIMIT ?""",
                [market, grain, *sources, _dt(from_ms), _dt(to_ms), max_rows]).fetchall()
        return rows

    # ------------------------------------------------------------------ API reads
    def rollup(self, market: str, minutes: float) -> dict:
        q = """
        WITH w AS (
          SELECT r.entity, e.sector, r.source,
                 arg_min(r.open, r.bucket_ts) AS v0, arg_max(r.close, r.bucket_ts) AS v1, sum(r.volume) AS vol, sum(r.n) AS n
          FROM rollups r JOIN entities e ON e.market = r.market AND e.entity = r.entity
          WHERE r.market = ? AND r.grain = '1m' AND r.bucket_ts >= now() - (? * INTERVAL 1 MINUTE)
          GROUP BY 1, 2, 3)
        SELECT entity, sector, source, v0, v1, v1 / NULLIF(v0, 0) - 1 AS ret, vol, n FROM w ORDER BY vol DESC NULLS LAST
        """
        with self.lock:
            rows = self.con.execute(q, [market, minutes]).fetchall()
        ents = [dict(entity=r[0], sector=r[1], source=r[2], v0=r[3], v1=r[4], ret=r[5], volume=r[6], n=r[7]) for r in rows]
        sec: dict[str, dict] = {}
        for e in ents:
            s = sec.setdefault(e["sector"], {"sector": e["sector"], "volume": 0.0, "wret": 0.0, "n": 0})
            v = e["volume"] or 0.0
            s["volume"] += v
            if e["ret"] is not None:
                s["wret"] += v * e["ret"]
            s["n"] += 1
        for s in sec.values():
            s["ret_vw"] = s["wret"] / s["volume"] if s["volume"] else None
            del s["wret"]
        return {"market": market, "minutes": minutes, "entities": ents, "sectors": list(sec.values()),
                "computed_at": datetime.now(timezone.utc).isoformat()}

    def history(self, market: str, entity: str, grain: str = "1m", limit: int = 500) -> list[dict]:
        with self.lock:
            if grain == "raw":
                rows = self.con.execute(
                    "SELECT source, epoch_ms(ts), value, volume, energy, ref, delta, backfill FROM samples "
                    "WHERE market=? AND entity=? ORDER BY ts DESC LIMIT ?", [market, entity, limit]).fetchall()
                return [dict(source=r[0], ts=r[1], value=r[2], volume=r[3], energy=r[4], ref=r[5], delta=r[6], backfill=r[7])
                        for r in reversed(rows)]
            rows = self.con.execute(
                "SELECT source, epoch_ms(bucket_ts), open, high, low, close, volume, energy, n FROM rollups "
                "WHERE market=? AND entity=? AND grain=? ORDER BY bucket_ts DESC LIMIT ?",
                [market, entity, grain, limit]).fetchall()
        return [dict(source=r[0], ts=r[1], open=r[2], high=r[3], low=r[4], close=r[5], volume=r[6], energy=r[7], n=r[8])
                for r in reversed(rows)]

    def stats(self) -> dict:
        with self.lock:
            s = self.con.execute("SELECT market, source, backfill, count(*), epoch_ms(min(ts)), epoch_ms(max(ts)) "
                                 "FROM samples GROUP BY ALL ORDER BY 1, 2, 3").fetchall()
            r = self.con.execute("SELECT market, grain, count(*) FROM rollups GROUP BY 1, 2 ORDER BY 1, 2").fetchall()
        return {"file": str(self.path),
                "samples": [dict(market=x[0], source=x[1], backfill=x[2], rows=x[3], first=x[4], last=x[5]) for x in s],
                "rollups": [dict(market=x[0], grain=x[1], rows=x[2]) for x in r]}

    def close(self):
        with self.lock:
            self.con.close()
