"""MarketEngine: one per market. Ingests Observations from an adapter, keeps rolling windows,
computes deltas, Hawkes burst scores, the sector order parameter (phase) and correlation edges,
persists every sample to DuckDB history, and broadcasts snapshots + diffs to SSE subscribers.

Market-agnostic: everything market-specific is in the config + adapter. Update cadence is a
property of the adapter's *sources* (seconds for Binance, ~1 min for Yahoo, daily for App Store),
not an engine constant; the UI push and edge-recompute rates are derived from it.
"""
from __future__ import annotations

import asyncio
import bisect
import json
import logging
import math
import time
import warnings
from collections import deque
from typing import Any, Optional

import numpy as np

from .model import Observation, load_sectors
from .organism_math import EventDetector, HawkesBurst, correlation_edges, returns_matrix, sector_series

log = logging.getLogger("engine")

DEFAULTS = {
    "bucket_s": 10,            # time bucket for return series
    "corr_window": 90,         # buckets in the rolling correlation window
    "corr_min": 12,            # min returns before an entity gets edges
    "corr_source": None,       # which source's value series drives correlation (default: primary source)
    "edge_mode": "raw",        # raw | residual (market mode removed)
    "edge_top_k": 3,
    "edge_min_abs": 0.3,
    "sector_edge_min_abs": 0.2,
    "sector_edge_top_k": 2,
    "delta_window_s": 300,
    "emit_ms": None,           # None -> derived from the fastest source cadence (1–5 s)
    "edges_every_s": None,     # None -> derived from cadence (10–600 s)
    "clock": "wall",           # wall | data
    "persist": True,
    "raw_retention_days": None,  # prune raw samples older than this (roll-ups are kept forever)
    "hawkes": {"tau_short_s": 20, "tau_long_s": 900, "alpha": 1.0, "floor_per_s": 0.002},
    "event": {"z_vol": 4.0, "z_ret": 3.0, "halflife_obs": 120, "warm": 30},
    "phase": {"M_on": 0.7, "B_on": 2.0, "M_off": 0.5, "B_off": 1.3, "min_members": 3},
}


def _merge(d: dict, u: dict) -> dict:
    out = dict(d)
    for k, v in (u or {}).items():
        out[k] = _merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


def _sig(x: Optional[float], n: int = 6):
    if x is None or (isinstance(x, float) and not math.isfinite(x)):
        return None
    if x == 0:
        return 0.0
    return float(f"{x:.{n}g}")


def _rnd(x: Optional[float], n: int):
    if x is None or (isinstance(x, float) and not math.isfinite(x)):
        return None
    return round(float(x), n)


def _now() -> int:
    return int(time.time() * 1000)


class EntState:
    __slots__ = ("value", "value_ts", "bar_prev", "energy", "ref", "delta_ref", "ts", "missing", "extra",
                 "win", "last_event_ts", "src")

    def __init__(self):
        self.value = None
        self.value_ts = 0
        self.bar_prev = None
        self.energy = None
        self.ref = None
        self.delta_ref = None
        self.ts = None
        self.missing: Optional[str] = "waiting for first data"
        self.extra: dict = {}
        self.win: deque = deque()
        self.last_event_ts = -1
        self.src: dict[str, dict] = {}   # per source: rx (ms), ts, v, e, d, miss


class MarketEngine:
    def __init__(self, cfg: dict, store=None):
        self.cfg = cfg
        self.id = cfg["id"]
        self.p = _merge(DEFAULTS, cfg.get("engine", {}))
        self.sectors = load_sectors(cfg)
        self.entities = []
        seen = set()
        for s in self.sectors:
            for e in s.entities:
                if e.id in seen:
                    raise ValueError(f"duplicate entity id {e.id} in {self.id}")
                seen.add(e.id)
                self.entities.append(e)
        self.ids = [e.id for e in self.entities]
        self.idx = {e.id: i for i, e in enumerate(self.entities)}
        self.sec_ids = [s.id for s in self.sectors]
        self.sec_of = np.array([self.sec_ids.index(e.sector) for e in self.entities])
        self.groups = [np.where(self.sec_of == g)[0] for g in range(len(self.sectors))]

        n = len(self.entities)
        self.state = [EntState() for _ in range(n)]
        h, ev = self.p["hawkes"], self.p["event"]
        self.hawkes = [HawkesBurst(h["tau_short_s"], h["tau_long_s"], h["alpha"]) for _ in range(n)]
        self.sec_hawkes = [HawkesBurst(h["tau_short_s"], h["tau_long_s"], h["alpha"]) for _ in self.sectors]
        self.detect = [EventDetector(ev["z_vol"], ev["z_ret"], ev["halflife_obs"], ev["warm"]) for _ in range(n)]
        self.sec_phase = [False] * len(self.sectors)

        self.bucket_ms = int(self.p["bucket_s"] * 1000)
        self.bucket_ids: list[int] = []
        self.bvals: dict[int, dict[int, float]] = {}

        # history
        self.store = store if self.p.get("persist", True) else None
        self.raw_store = store
        self.pending_samples: list[tuple] = []
        self.pending_events: list[tuple[str, int, float]] = []
        self.hist_max: dict[tuple[str, str], int] = {}   # persist guard: last stored ts per (entity, source)
        self.n_persisted = 0
        self._last_prune = 0
        if store is not None:
            store.register_entities(self.id, [(e.id, e.sector, e.label) for e in self.entities])

        # sources (set by the adapter)
        self.sources: dict[str, dict] = {}
        self.primary: Optional[str] = None
        self.corr_source: Optional[str] = None
        self.expected: list[list[str]] = [[] for _ in range(n)]

        self.edges: list = []
        self.sector_edges: list = []
        self.edge_info: dict = {"n_obs": 0, "n_included": 0, "computed_at": None}
        self.last_data_ts: Optional[int] = None
        self.n_obs = 0
        self.status: dict[str, dict] = {}
        self.subscribers: set[asyncio.Queue] = set()
        self._last_sent: dict[str, Any] = {}
        self._last_sec_sent: dict[str, Any] = {}
        self._status_dirty = True
        self._sources_dirty = True

    # ------------------------------------------------------------------ sources
    def set_sources(self, sources: list[dict]):
        """Called once with the adapter's declared sources:
        {id, label, cadence_s, stale_after_s, planned?: bool, note?: str}."""
        for s in sources:
            s = dict(s)
            s.setdefault("stale_after_s", s["cadence_s"] * 3 + 30)
            s.setdefault("planned", False)
            s.update({"state": "planned" if s["planned"] else "waiting", "last_ok": None, "last_attempt": None,
                      "msg": s.get("note", ""), "n": None, "_logged": 0})
            self.sources[s["id"]] = s
        real = [s for s in self.sources.values() if not s["planned"]]
        self.primary = self.cfg.get("primary_source") or (real[0]["id"] if real else None)
        self.corr_source = self.p.get("corr_source") or self.primary
        default = self.cfg.get("default_sources") or [s["id"] for s in self.sources.values()]
        for i, e in enumerate(self.entities):
            self.expected[i] = list(e.meta.get("sources") or default)
        fastest = min((s["cadence_s"] for s in real), default=60)
        if self.p["emit_ms"] is None:
            self.p["emit_ms"] = int(min(max(fastest * 1000, 1000), 5000))
        if self.p["edges_every_s"] is None:
            self.p["edges_every_s"] = min(max(fastest * 10, 10), 600)

    def _log_source(self, sid: str, force: bool):
        s = self.sources[sid]
        now = _now()
        if self.raw_store is not None and (force or now - s["_logged"] >= max(60_000, s["cadence_s"] * 1000)):
            s["_logged"] = now
            try:
                self.raw_store.log_source(self.id, sid, now, s["state"], s["n"] or 0, s["msg"] or "")
            except Exception:
                log.exception("[%s] source log failed", self.id)

    def source_ok(self, sid: str, n: Optional[int] = None, msg: Optional[str] = None):
        s = self.sources.get(sid)
        if s is None:
            return
        changed = s["state"] != "ok" or (msg is not None and msg != s["msg"])
        now = _now()
        s.update(state="ok", last_ok=now, last_attempt=now)
        if n is not None:
            s["n"] = n
        if msg is not None:
            s["msg"] = msg
        if changed:
            self._sources_dirty = True
            log.info("[%s] source %s ok: %s", self.id, sid, s["msg"])
        self._log_source(sid, changed)

    def source_fail(self, sid: str, state: str, msg: str):
        """state: error | skip"""
        s = self.sources.get(sid)
        if s is None:
            return
        changed = s["state"] != state or s["msg"] != msg
        s.update(state=state, msg=msg, last_attempt=_now())
        if changed:
            self._sources_dirty = True
            (log.warning if state == "error" else log.info)("[%s] source %s %s: %s", self.id, sid, state, msg)
        self._log_source(sid, changed)

    def last_ok(self, sid: str) -> Optional[int]:
        s = self.sources.get(sid)
        return s["last_ok"] if s else None

    # ------------------------------------------------------------------ adapter API
    def set_status(self, key: str, level: str, msg: str):
        """Free-form market status line (e.g. 'market closed'). level: ok | info | warn | error | skip."""
        cur = self.status.get(key)
        if cur and cur["level"] == level and cur["msg"] == msg:
            return
        self.status[key] = {"key": key, "level": level, "msg": msg, "ts": _now()}
        self._status_dirty = True
        (log.warning if level in ("warn", "error") else log.info)("[%s] %s: %s", self.id, key, msg)

    def mark_missing(self, entity: str, reason: str, source: Optional[str] = None):
        i = self.idx.get(entity)
        if i is None:
            return
        st = self.state[i]
        sid = source or self.primary
        st.src.setdefault(sid, {})["miss"] = reason
        if sid == self.primary and st.value is None and st.energy is None:
            st.missing = reason

    def now_ms(self) -> int:
        if self.p["clock"] == "data" and self.last_data_ts:
            return self.last_data_ts
        return _now()

    def _bucket(self, i: int, ts: int, v: float):
        b = ts // self.bucket_ms
        if b not in self.bvals:
            bisect.insort(self.bucket_ids, b)
            self.bvals[b] = {}
        self.bvals[b][i] = v

    def ingest(self, obs: list[Observation], persist: bool = True, backfill: bool = False, warm: bool = False):
        """persist: append to DuckDB history (default). warm: replaying stored history at start-up
        (no event detection, no re-persisting)."""
        win_ms = self.p["delta_window_s"] * 1000
        rx = _now()
        for o in obs:
            i = self.idx.get(o.entity)
            if i is None:
                continue
            st = self.state[i]
            sid = o.source or self.primary
            sv = st.src.setdefault(sid, {})
            sv["rx"] = o.ts if warm else rx
            sv["ts"] = o.ts if sv.get("ts") is None else max(sv["ts"], o.ts)
            sv.pop("miss", None)
            primary = sid == self.primary
            if not warm:
                self.n_obs += 1
            if persist and not warm and self.store is not None:
                key = (o.entity, sid)
                if o.ts > self.hist_max.get(key, -1):
                    self.hist_max[key] = o.ts
                    self.pending_samples.append((o.entity, sid, o.ts, o.value, o.volume, o.energy, o.ref, o.delta,
                                                 json.dumps(o.extra, ensure_ascii=False) if o.extra else None, backfill))
            v = o.value
            good_v = v is not None and math.isfinite(v) and (v > 0 or not primary)
            if good_v and sid == self.corr_source and v > 0:
                self._bucket(i, o.ts, v)
            if not primary:
                if good_v:
                    sv["v"] = v
                if o.energy is not None:
                    sv["e"] = o.energy
                if o.delta is not None:
                    sv["d"] = o.delta
            else:
                st.missing = None
                st.ts = o.ts if st.ts is None else max(st.ts, o.ts)
                self.last_data_ts = o.ts if self.last_data_ts is None else max(self.last_data_ts, o.ts)
                if good_v and o.ts >= st.value_ts:
                    st.value, st.value_ts = v, o.ts
                    w = st.win
                    if not (w and w[-1][0] // self.bucket_ms == o.ts // self.bucket_ms):
                        w.append((o.ts, v))
                    while len(w) >= 2 and w[1][0] <= o.ts - win_ms:
                        w.popleft()
                if o.energy is not None:
                    st.energy = o.energy
                if o.ref is not None:
                    st.ref = o.ref
                if o.delta is not None:
                    st.delta_ref = o.delta
                elif st.ref and st.value:
                    st.delta_ref = st.value / st.ref - 1
            act = o.activity if o.activity is not None else o.volume
            if act is not None and not warm:
                r = math.log(v / st.bar_prev) if (good_v and v > 0 and st.bar_prev) else None
                if good_v and v > 0:
                    st.bar_prev = v
                mark = self.detect[i].update(r, act)
                g = self.sec_of[i]
                if mark > 0:
                    self.hawkes[i].add(o.ts, mark)
                    self.sec_hawkes[g].add(o.ts, mark)
                    self.pending_events.append((o.entity, o.ts, mark))
                elif self.detect[i].n > self.detect[i].warm:
                    self.hawkes[i].start(o.ts)
                    self.sec_hawkes[g].start(o.ts)
            if o.events:
                g = self.sec_of[i]
                for t, m in sorted(o.events):
                    if t <= st.last_event_ts:
                        continue
                    st.last_event_ts = t
                    self.hawkes[i].add(t, m)
                    self.sec_hawkes[g].add(t, m)
                    if not warm:
                        self.pending_events.append((o.entity, t, m))
            if o.extra:
                st.extra.update(o.extra)

    def persist_backfill(self, obs: list[Observation], guard: bool = True) -> int:
        """Store historical samples (REST klines, yfinance history, RSS pages, DataLab ranges) without
        touching live state. guard=True skips rows older than what is already stored for (entity, source);
        guard=False is for callers that computed an explicit gap window (e.g. before live data began)."""
        if self.store is None:
            return 0
        rows = []
        for o in obs:
            sid = o.source or self.primary
            key = (o.entity, sid)
            if guard and o.ts <= self.hist_max.get(key, -1):
                continue
            rows.append((o.entity, sid, o.ts, o.value, o.volume, o.energy, o.ref, o.delta,
                         json.dumps(o.extra, ensure_ascii=False) if o.extra else None, True))
        if not rows:
            return 0
        rows.sort(key=lambda r: r[2])
        for r in rows:
            self.hist_max[(r[0], r[1])] = max(self.hist_max.get((r[0], r[1]), -1), r[2])
        n = self.store.append_samples(self.id, rows)
        self.store.update_rollups(self.id, rows[0][2])
        self.n_persisted += n
        return n

    # ------------------------------------------------------------------ warm start from history
    def warm_from_history(self):
        st = self.raw_store
        if st is None:
            return {}
        info = {}
        for sid, row in st.source_last(self.id).items():
            s = self.sources.get(sid)
            if s and not s["planned"]:
                s["last_ok"], s["last_attempt"] = row["last_ok"], row["last_attempt"]
                s["state"] = row["state"] if row["state"] in ("ok", "error", "skip") else s["state"]
                s["msg"] = (row["msg"] or "") + " (from history)"
        real = [s for s in self.sources.values() if not s["planned"]]
        slow = max((s["cadence_s"] for s in real), default=60)
        now = _now()
        lookback = int(min(max(20 * slow, 3 * 3600), 60 * 86400) * 1000)
        # 1) correlation series
        if self.corr_source:
            span = int((self.p["corr_window"] + 2) * self.bucket_ms)
            ser = st.series(self.id, self.corr_source, self.p["bucket_s"], now - span)
            self.ingest([Observation(entity=e, ts=t, value=v, source=self.corr_source) for e, t, v in ser],
                        persist=False, warm=True)
            info["series_rows"] = len(ser)
        # 2) latest state per (entity, source)
        latest = st.latest_samples(self.id, now - lookback)
        obs = []
        for ent, sid, ts, v, e, ref, d, extra in latest:
            obs.append(Observation(entity=ent, ts=ts, source=sid, value=v, energy=e, ref=ref, delta=d,
                                   extra=json.loads(extra) if extra else None))
        obs.sort(key=lambda o: o.ts)
        self.ingest(obs, persist=False, warm=True)
        info["latest_rows"] = len(latest)
        # 3) Hawkes events
        evs = st.recent_events(self.id, now - int(self.p["hawkes"]["tau_long_s"] * 3000))
        for ent, t, m in evs:
            i = self.idx.get(ent)
            if i is not None:
                self.hawkes[i].add(t, m)
                self.sec_hawkes[self.sec_of[i]].add(t, m)
                self.state[i].last_event_ts = max(self.state[i].last_event_ts, t)
        info["events"] = len(evs)
        # 4) persist guard
        self.hist_max = st.max_ts(self.id)
        self._sources_dirty = True
        log.info("[%s] warmed from history: %s", self.id, info)
        return info

    # ------------------------------------------------------------------ state
    def _ent_state(self, i: int, now: int) -> dict:
        st = self.state[i]
        dw, partial = None, None
        if st.value and st.win:
            t0, v0 = st.win[0]
            if v0:
                dw = st.value / v0 - 1
                partial = (now - t0) < self.p["delta_window_s"] * 1000 * 0.9
        hk = self.hawkes[i]
        b = x = None
        if hk.t0 is not None:
            rs, rl = hk.rates(now)
            b = rs / max(rl, self.p["hawkes"]["floor_per_s"])
            x = rs
        exp = self.expected[i]
        sx, sm, sv = {}, {}, {}
        for sid in exp:
            d = st.src.get(sid) or {}
            sx[sid] = d.get("rx")
            if d.get("miss"):
                sm[sid] = d["miss"]
            if sid != self.primary and any(k in d for k in ("v", "e", "d")):
                sv[sid] = {k: _sig(d.get(k), 5) for k in ("v", "e", "d") if d.get(k) is not None}
        have = sum(1 for sid in exp if sx.get(sid) and sid not in sm)
        return {
            "v": _sig(st.value), "e": _sig(st.energy, 4), "dr": _rnd(st.delta_ref, 5), "dw": _rnd(dw, 5),
            "dwp": partial, "b": _rnd(b, 2), "x": _sig(x, 3), "ts": st.ts, "m": st.missing,
            "xt": st.extra or None, "sc": [have, len(exp)], "sx": sx, "sm": sm or None, "sv": sv or None,
        }

    def _sector_state(self, ent_states: list[dict], now: int) -> dict:
        out = {}
        ph = self.p["phase"]
        for g, s in enumerate(self.sectors):
            mem = self.groups[g]
            E = 0.0
            wr = ww = Er = Ew = 0.0
            spins = []
            live = have = exp = 0
            for i in mem:
                es = ent_states[i]
                if es["m"] is None:
                    live += 1
                have += es["sc"][0]
                exp += es["sc"][1]
                e = es["e"] or 0.0
                E += e
                if es["dr"] is not None:
                    wr += e * es["dr"]; Er += e
                d = es["dw"] if es["dw"] is not None else es["dr"]
                if es["dw"] is not None:
                    ww += e * es["dw"]; Ew += e
                if d is not None and d != 0:
                    spins.append(1.0 if d > 0 else -1.0)
            M = sum(spins) / len(spins) if spins else None
            hk = self.sec_hawkes[g]
            B = None
            if hk.t0 is not None:
                rs, rl = hk.rates(now)
                B = rs / max(rl, self.p["hawkes"]["floor_per_s"])
            on = self.sec_phase[g]
            if M is not None and B is not None and len(spins) >= ph["min_members"]:
                if not on and abs(M) >= ph["M_on"] and B >= ph["B_on"]:
                    on = True
                elif on and (abs(M) < ph["M_off"] or B < ph["B_off"]):
                    on = False
            else:
                on = False
            self.sec_phase[g] = on
            out[s.id] = {"e": _sig(E, 4), "dr": _rnd(wr / Er, 5) if Er else None,
                         "dw": _rnd(ww / Ew, 5) if Ew else None, "M": _rnd(M, 3), "b": _rnd(B, 2),
                         "phase": on, "n": live, "N": int(mem.size), "cov": [have, exp]}
        return out

    def sources_public(self) -> list[dict]:
        return [{k: v for k, v in s.items() if not k.startswith("_")} for s in self.sources.values()]

    def meta(self) -> dict:
        c = self.cfg
        return {
            "id": self.id, "title": c.get("title", self.id), "mode": c.get("mode", "live"),
            "source": c.get("source", ""), "note": c.get("note", ""), "labels": c.get("labels", {}),
            "view": c.get("view", {}), "replay": c.get("replay", {}), "primary_source": self.primary,
            "corr_source": self.corr_source, "history": self.store is not None,
            "engine": {k: self.p[k] for k in ("bucket_s", "corr_window", "corr_min", "edge_mode", "edge_top_k",
                                              "edge_min_abs", "delta_window_s", "clock", "emit_ms", "edges_every_s")}
                      | {"hawkes": self.p["hawkes"], "phase": self.p["phase"]},
        }

    def snapshot(self) -> dict:
        now = self.now_ms()
        es = [self._ent_state(i, now) for i in range(len(self.entities))]
        return {
            "type": "snapshot", "t": _now(), "data_ts": self.last_data_ts, "meta": self.meta(),
            "sectors": [{"id": s.id, "label": s.label, "members": [e.id for e in s.entities], "meta": s.meta}
                        for s in self.sectors],
            "entities": [{"id": e.id, "label": e.label, "sector": e.sector, "meta": e.meta, "s": es[i]}
                         for i, e in enumerate(self.entities)],
            "sector_state": self._sector_state(es, now),
            "edges": self.edges, "sector_edges": self.sector_edges, "edge_info": self.edge_info,
            "status": list(self.status.values()), "sources": self.sources_public(), "n_obs": self.n_obs,
            "n_persisted": self.n_persisted,
        }

    def diff(self) -> Optional[dict]:
        now = self.now_ms()
        es = [self._ent_state(i, now) for i in range(len(self.entities))]
        ch = {}
        for i, s in enumerate(es):
            key = self.ids[i]
            if self._last_sent.get(key) != s:
                ch[key] = s
                self._last_sent[key] = s
        sec = self._sector_state(es, now)
        sch = {k: v for k, v in sec.items() if self._last_sec_sent.get(k) != v}
        self._last_sec_sent.update(sch)
        msg = {"type": "diff", "t": _now(), "data_ts": self.last_data_ts, "ents": ch, "sectors": sch,
               "n_obs": self.n_obs, "n_persisted": self.n_persisted}
        if self._status_dirty:
            msg["status"] = list(self.status.values())
            self._status_dirty = False
        # sources: last_ok moves every tick for fast sources; send every diff (small) so freshness is exact
        msg["sources"] = self.sources_public()
        self._sources_dirty = False
        return msg

    # ------------------------------------------------------------------ edges
    def _build_matrix(self):
        now = self.now_ms()
        cur = now // self.bucket_ms
        cols = [b for b in self.bucket_ids if (b < cur or self.p["clock"] == "data")]
        cols = cols[-(self.p["corr_window"] + 1):]
        V = np.full((len(self.entities), len(cols)), np.nan)
        for j, b in enumerate(cols):
            for i, v in self.bvals[b].items():
                V[i, j] = v
        return V

    def compute_edges_sync(self, V: np.ndarray):
        if V.shape[1] < 3:
            return [], [], {"n_obs": 0, "n_included": 0}
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            R = returns_matrix(V)
            residual = self.p["edge_mode"] == "residual"
            edges, info = correlation_edges(R, self.ids, self.p["corr_min"], self.p["edge_top_k"],
                                            self.p["edge_min_abs"], residual)
            SR = sector_series(R, self.groups, residual)
            sedges, _ = correlation_edges(SR, self.sec_ids, self.p["corr_min"], self.p["sector_edge_top_k"],
                                          self.p["sector_edge_min_abs"], False)
        return edges, sedges, info

    async def edges_loop(self):
        V = np.zeros((0, 0))
        while True:
            edges = []
            try:
                V = self._build_matrix()
                edges, sedges, info = await asyncio.to_thread(self.compute_edges_sync, V)
                self.edges, self.sector_edges = edges, sedges
                self.edge_info = info | {"computed_at": _now(), "source": self.corr_source}
                self.broadcast({"type": "edges", "edges": edges, "sector_edges": sedges, "edge_info": self.edge_info})
            except Exception:
                log.exception("[%s] edges failed", self.id)
            await asyncio.sleep(self.p["edges_every_s"] if (edges or V.shape[1] >= self.p["corr_window"]) else 3)

    # ------------------------------------------------------------------ persistence
    def flush(self):
        """Synchronous flush (collect mode / shutdown)."""
        self._write(*self._take())

    def _take(self):
        keep = self.p["corr_window"] + 2
        if len(self.bucket_ids) > keep:
            for b in self.bucket_ids[:-keep]:
                self.bvals.pop(b, None)
            self.bucket_ids = self.bucket_ids[-keep:]
        rows, self.pending_samples = self.pending_samples, []
        ev, self.pending_events = self.pending_events, []
        return rows, ev

    def _write(self, rows, ev):
        if self.store is None:
            return
        try:
            if rows:
                self.n_persisted += self.store.append_samples(self.id, rows)
                self.store.update_rollups(self.id, min(r[2] for r in rows))
            self.store.append_events(self.id, ev)
            ret = self.p.get("raw_retention_days")
            if ret and time.time() - self._last_prune > 3600:
                self._last_prune = time.time()
                self.store.prune_raw(self.id, ret)
        except Exception:
            log.exception("[%s] persist failed", self.id)

    async def flush_loop(self):
        while True:
            await asyncio.sleep(5)
            try:
                rows, ev = self._take()          # on the event loop (owns the in-memory structures)
                await asyncio.to_thread(self._write, rows, ev)   # DuckDB I/O off the loop
            except Exception:
                log.exception("[%s] flush failed", self.id)

    # ------------------------------------------------------------------ broadcast
    def broadcast(self, msg: dict):
        if not self.subscribers:
            return
        data = json.dumps(msg, separators=(",", ":"), ensure_ascii=False)
        for q in list(self.subscribers):
            if q.full():
                while not q.empty():
                    q.get_nowait()
                q.put_nowait(json.dumps(self.snapshot(), separators=(",", ":"), ensure_ascii=False))
            if not q.full():
                q.put_nowait(data)

    async def emit_loop(self):
        while True:
            await asyncio.sleep(self.p["emit_ms"] / 1000)
            try:
                if self.subscribers:
                    self.broadcast(self.diff())
            except Exception:
                log.exception("[%s] emit failed", self.id)

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=64)
        self.subscribers.add(q)
        return q

    def unsubscribe(self, q):
        self.subscribers.discard(q)
