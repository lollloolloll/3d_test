"""SIMULATED market — synthetic data for offline demos and scale tests (thousands of cells).

Everything this adapter produces is made up. The config sets mode "simulated" and the UI
shows a SIMULATED banner. Do not use it to make claims about any real market.
Nothing is persisted (config engine.persist = false) so simulated rows can never mix with history.

Model: log-price r_i = β_m·f_market + β_s·f_sector(i) + ε_i ; each sector has a self-exciting
(Hawkes) shock process whose events add volume spikes and a common push to members, so the
real engine's burst / phase-transition detection has something to find.
"""
from __future__ import annotations

import asyncio
import math
import time

import numpy as np

from ..model import Observation
from .base import Adapter


class SimulatorAdapter(Adapter):
    mode = "simulated"
    SOURCES = [{"id": "sim", "label": "SIMULATED generator (not real data)", "cadence_s": 1, "stale_after_s": 15}]

    async def run(self):
        eng = self.engine
        rng = np.random.default_rng(int(self.opts.get("seed", 7)))
        n = len(eng.entities)
        S = len(eng.sectors)
        sec = eng.sec_of
        price = np.exp(rng.normal(3, 1.5, n))
        energy = np.exp(rng.normal(14, 1.6, n))
        ref = price.copy()
        lam = np.full(S, 0.01)  # sector shock intensity (per s)
        mu, jump, tau = 0.01, 0.06, 30.0
        dt = float(self.opts.get("dt_s", 1.0))
        eng.set_status("sim", "warn", f"SIMULATED data · {n} synthetic entities · not a real market")
        push = np.zeros(S)
        while True:
            t = int(time.time() * 1000)
            lam = mu + (lam - mu) * math.exp(-dt / tau)
            ev = rng.random(S) < lam * dt
            lam = lam + ev * jump
            push = push * 0.8 + ev * rng.choice([-1, 1], S) * 0.004
            fm = rng.normal(0, 0.0008)
            fs = rng.normal(0, 0.0006, S) + push
            r = 0.9 * fm + fs[sec] + rng.normal(0, 0.0010, n)
            price *= np.exp(r)
            vol_mult = 1 + 6 * (lam[sec] / (mu + jump)) * rng.random(n)
            vol = energy / 86400 * dt * vol_mult * np.exp(rng.normal(0, 0.4, n))
            energy = energy * 0.9995 + vol * 0.5
            eng.ingest([Observation(entity=eng.ids[i], ts=t, value=float(price[i]), volume=float(vol[i]),
                                    energy=float(energy[i]), ref=float(ref[i]), source="sim") for i in range(n)])
            eng.source_ok("sim", n, "SIMULATED tick")
            await asyncio.sleep(dt)
