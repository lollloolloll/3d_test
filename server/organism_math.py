"""The math behind the organism: burst intensity, event detection, correlation edges.

Everything here is market-agnostic and documented in README.md ("The math").
"""
from __future__ import annotations

import math
from typing import Optional

import numpy as np


class HawkesBurst:
    """Hawkes-style exponential-kernel intensity, two time scales.

    A Hawkes process has intensity  λ(t) = μ + Σ_i α·m_i·exp(-β (t - t_i)).
    We track the excitation sum with a fast kernel (τs = 1/βs, the "burst" memory)
    and a slow kernel (τl = 1/βl, the "baseline" memory), both updated recursively
    in O(1) per event:   S ← S·exp(-Δt/τ) + α·m

    Each sum is normalised to a rate with the finite-history correction
        rate = S / (τ · (1 - exp(-elapsed/τ)))
    so a stationary process gives rate_short ≈ rate_long ≈ true rate even during warm-up.

    burst score B = rate_short / max(rate_long, floor)
        B ≈ 1  normal activity,   B ≫ 1  self-exciting cascade (burst),   B < 1  quiet
    α and β are config values, not MLE fits (fitting them is a listed next step).
    """

    __slots__ = ("tau_s", "tau_l", "alpha", "S", "L", "t", "t0", "n")

    def __init__(self, tau_short_s: float, tau_long_s: float, alpha: float = 1.0):
        self.tau_s = tau_short_s * 1000.0
        self.tau_l = tau_long_s * 1000.0
        self.alpha = alpha
        self.S = 0.0
        self.L = 0.0
        self.t: Optional[float] = None  # last decay time (ms)
        self.t0: Optional[float] = None  # start of observation (ms)
        self.n = 0

    def start(self, t_ms: float):
        if self.t0 is None or t_ms < self.t0:
            self.t0 = t_ms
        if self.t is None:
            self.t = t_ms

    def _decay(self, t_ms: float):
        if self.t is None:
            self.t = t_ms
            return
        dt = t_ms - self.t
        if dt <= 0:
            return
        self.S *= math.exp(-dt / self.tau_s)
        self.L *= math.exp(-dt / self.tau_l)
        self.t = t_ms

    def add(self, t_ms: float, mark: float = 1.0):
        self.start(t_ms)
        if self.t is not None and t_ms < self.t:
            # late event: add it already-decayed (keeps the recursion exact)
            dt = self.t - t_ms
            self.S += self.alpha * mark * math.exp(-dt / self.tau_s)
            self.L += self.alpha * mark * math.exp(-dt / self.tau_l)
        else:
            self._decay(t_ms)
            self.S += self.alpha * mark
            self.L += self.alpha * mark
        self.n += 1

    def rates(self, t_ms: float) -> tuple[float, float]:
        if self.t0 is None:
            return 0.0, 0.0
        self._decay(t_ms)
        el = max(t_ms - self.t0, 1.0)
        cs = self.tau_s * (1 - math.exp(-el / self.tau_s))
        cl = self.tau_l * (1 - math.exp(-el / self.tau_l))
        return self.S / cs * 1000.0, self.L / cl * 1000.0  # events (mark units) per second

    def score(self, t_ms: float, floor_per_s: float) -> float:
        rs, rl = self.rates(t_ms)
        return rs / max(rl, floor_per_s)


class EventDetector:
    """Turns a stream of (return, volume) observations into point events for the Hawkes kernel.

    An observation is an event when its volume is z_vol× its EWMA, or its |return| exceeds
    z_ret·σ (EWMA std). mark = max(vol ratio / z_vol, |r|/σ / z_ret) clipped to [1, 5].
    """

    __slots__ = ("z_vol", "z_ret", "hl", "ev", "er2", "n", "warm")

    def __init__(self, z_vol: float = 4.0, z_ret: float = 3.0, halflife_obs: float = 120, warm: int = 30):
        self.z_vol, self.z_ret = z_vol, z_ret
        self.hl = 1 - 0.5 ** (1 / halflife_obs)
        self.ev = None  # EWMA volume
        self.er2 = None  # EWMA squared return
        self.n = 0
        self.warm = warm

    def update(self, r: Optional[float], vol: Optional[float]) -> float:
        """Returns mark (>0) if event, else 0."""
        mark = 0.0
        if self.n >= self.warm:
            m1 = (vol / self.ev / self.z_vol) if (vol is not None and self.ev and self.ev > 0) else 0.0
            sig = math.sqrt(self.er2) if self.er2 else 0.0
            m2 = (abs(r) / sig / self.z_ret) if (r is not None and sig > 0) else 0.0
            m = max(m1, m2)
            if m >= 1.0:
                mark = min(m, 5.0)
        a = self.hl
        if vol is not None:
            self.ev = vol if self.ev is None else (1 - a) * self.ev + a * vol
        if r is not None:
            self.er2 = r * r if self.er2 is None else (1 - a) * self.er2 + a * r * r
        self.n += 1
        return mark


def returns_matrix(V: np.ndarray) -> np.ndarray:
    """V: [n_entities, T] levels with NaN gaps. Forward-fill along time, then log returns.
    Leading NaNs stay NaN."""
    V = V.copy()
    n, T = V.shape
    for j in range(1, T):
        col = V[:, j]
        m = np.isnan(col)
        col[m] = V[m, j - 1]
    with np.errstate(divide="ignore", invalid="ignore"):
        L = np.log(np.where(V > 0, V, np.nan))
    return np.diff(L, axis=1)


def correlation_edges(R: np.ndarray, ids: list[str], min_obs: int, top_k: int, min_abs: float,
                      residual: bool) -> tuple[list[list], dict]:
    """Rolling correlation edges.

    R: [n, T-1] log returns (NaN where unknown). Uses the common window where every
    included entity has data. Entities with fewer than min_obs returns are excluded.
    residual=True removes the equal-weight market mode first (cross-sectional mean
    return per time step) so edges show co-movement *beyond* "everything follows the market".
    Returns edges [[id_a, id_b, rho], ...] (top_k per node, |rho| >= min_abs) and info.
    """
    n, T = R.shape
    info = {"n_obs": 0, "n_included": 0}
    if T < min_obs or n < 2:
        return [], info
    valid = ~np.isnan(R)
    # first index from which an entity is continuously valid
    first = np.full(n, T)
    for i in range(n):
        bad = np.where(~valid[i])[0]
        first[i] = (bad[-1] + 1) if bad.size else 0
    inc = np.where(T - first >= min_obs)[0]
    if inc.size < 2:
        return [], info
    start = int(first[inc].max())
    X = R[inc, start:]
    if residual:
        X = X - X.mean(axis=0, keepdims=True)
    sd = X.std(axis=1)
    ok = sd > 1e-12
    inc, X, sd = inc[ok], X[ok], sd[ok]
    if inc.size < 2:
        return [], info
    Xc = (X - X.mean(axis=1, keepdims=True)) / sd[:, None]
    C = (Xc @ Xc.T) / X.shape[1]
    np.fill_diagonal(C, 0.0)
    info = {"n_obs": int(X.shape[1]), "n_included": int(inc.size)}
    A = np.abs(C)
    k = min(top_k, inc.size - 1)
    seen = set()
    edges = []
    idx = np.argpartition(-A, kth=k - 1, axis=1)[:, :k] if k > 0 else np.zeros((inc.size, 0), int)
    for a in range(inc.size):
        for b in idx[a]:
            if A[a, b] < min_abs:
                continue
            key = (min(a, b), max(a, b))
            if key in seen:
                continue
            seen.add(key)
            edges.append([ids[inc[key[0]]], ids[inc[key[1]]], round(float(C[key[0], key[1]]), 3)])
    return edges, info


def sector_series(R: np.ndarray, groups: list[np.ndarray], residual: bool) -> np.ndarray:
    """Mean return per sector (nan-aware) -> [n_sectors, T-1]."""
    X = R
    if residual:
        X = R - np.nanmean(R, axis=0, keepdims=True)
    out = np.full((len(groups), R.shape[1]), np.nan)
    for g, members in enumerate(groups):
        if members.size:
            with np.errstate(all="ignore"):
                out[g] = np.nanmean(X[members], axis=0) if members.size else np.nan
    return out
