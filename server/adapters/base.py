"""Adapter interface. An adapter turns one data source family into Observations.

To add a market:
  1. subclass Adapter (this folder), declare its SOURCES, register it in adapters/__init__.py
  2. write configs/<market>.json with "adapter": "<name>", sectors/entities, labels, engine params
The engine and the frontend need no changes.

Update cadence is a property of each *source* the adapter declares, not an engine constant:
    SOURCES = [{"id": "yahoo", "label": "Yahoo Finance", "cadence_s": 60, "stale_after_s": 300}]
A source with "planned": True is shown (and counted per node as "x/N sources") but not fetched yet,
so thin coverage stays visible instead of hidden.
"""
from __future__ import annotations

import abc
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..engine import MarketEngine


class Adapter(abc.ABC):
    #: provenance shown on screen; must be honest: live | delayed | daily | simulated
    mode: str = "live"
    #: declared sources (cadence lives here)
    SOURCES: list[dict] = []

    def __init__(self, cfg: dict, engine: "MarketEngine"):
        self.cfg = cfg
        self.opts = cfg.get("adapter_options", {})
        self.engine = engine

    def sources(self) -> list[dict]:
        """Override to derive cadence from options (e.g. a poll interval)."""
        return [dict(s) for s in self.SOURCES]

    @abc.abstractmethod
    async def run(self) -> None:
        """Long-running coroutine (server mode). Call self.engine.ingest([...]) as data arrives,
        self.engine.source_ok(source_id, n) / source_fail(source_id, 'error'|'skip', msg) after each
        fetch, and self.engine.mark_missing(entity_id, reason, source) for data that does not exist
        (drawn as empty, never filled with made-up numbers)."""

    async def cycle(self) -> dict:
        """One collection pass for `run.py --collect` (fetch + backfill, then return).
        Default: nothing to do in one-shot mode."""
        return {"note": f"{type(self).__name__} has no one-shot collection"}

    def entity_ids(self) -> list[str]:
        return list(self.engine.ids)
