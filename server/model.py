"""Generic market data model.

The engine only ever sees these types. It never knows which market it is drawing:
a market is an adapter (code that produces Observations) + a config file
(hierarchy, labels, math parameters).

    market ──< sector/cluster ──< entity
    entity has a time series of `value` (price, rating, search index, ...)
    and an `energy` (size: volume, attention, capital, rating count, ...)
    edges = rolling correlation between entity return series
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional

# Data provenance modes. Shown as the on-screen badge. Never lie about this.
MODES = ("live", "delayed", "daily", "simulated")


@dataclass
class EntitySpec:
    id: str
    label: str
    sector: str
    meta: dict[str, Any] = field(default_factory=dict)


@dataclass
class SectorSpec:
    id: str
    label: str
    entities: list[EntitySpec]
    meta: dict[str, Any] = field(default_factory=dict)


@dataclass
class Observation:
    """One measurement of one entity, emitted by an adapter.

    All fields except entity/ts are optional; the engine uses what is present.
      value   : level whose returns drive delta + correlation (price, rating, index)
      volume  : activity in this observation's interval (drives burst/event detection)
      energy  : absolute size of the cell (24h quote volume, dollar volume, rating count)
      ref     : reference level for delta_ref (24h open, previous close)
      delta   : adapter-supplied delta_ref (overrides value/ref) for non-price markets
      events  : explicit point events [(ts_ms, mark)] e.g. review arrivals
      extra   : free-form fields shown on hover
      source  : which declared source produced it (default: the market's primary source)
      activity: what the burst detector should look at, if different from volume (e.g. relative volume)
    """
    entity: str
    ts: int  # epoch milliseconds (source/event time, not receive time)
    value: Optional[float] = None
    volume: Optional[float] = None
    energy: Optional[float] = None
    ref: Optional[float] = None
    delta: Optional[float] = None
    events: Optional[list[tuple[int, float]]] = None
    extra: Optional[dict[str, Any]] = None
    source: Optional[str] = None
    activity: Optional[float] = None


def load_sectors(cfg: dict) -> list[SectorSpec]:
    """Config format: sectors: [{id, label, entities: [str | {id,label,...meta}]}]"""
    out = []
    for s in cfg["sectors"]:
        ents = []
        for e in s["entities"]:
            if isinstance(e, str):
                ents.append(EntitySpec(id=e, label=e, sector=s["id"]))
            else:
                meta = {k: v for k, v in e.items() if k not in ("id", "label")}
                ents.append(EntitySpec(id=e["id"], label=e.get("label", e["id"]), sector=s["id"], meta=meta))
        out.append(SectorSpec(id=s["id"], label=s.get("label", s["id"]), entities=ents,
                              meta={k: v for k, v in s.items() if k not in ("id", "label", "entities")}))
    return out
