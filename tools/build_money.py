"""Money Map data builder: 20 years of where money sits and where it moves, from official / market data only.

    python tools/build_money.py            # -> web/money/data.json  (≈1–2 MB, weekly frames)

Sources (all public, no key unless noted):
  * Federal Reserve Z.1 Financial Accounts (CSV package): quarterly amounts outstanding and *transactions*
    (actual net purchases) by sector — households, rest of world (foreigners), the Fed.
  * FRED (fredgraph.csv): weekly bank deposits, CPI, Fed funds, 10y yield, credit spread, oil, Fed balance sheet,
    reverse repo, M2, Korea rates (OECD).
  * Yahoo Finance via yfinance: weekly prices for co-movement and for nowcasting equity value between quarters.
  * DefiLlama: total stablecoin supply (daily).
  * Bank of Korea ECOS (needs ECOS_API_KEY): not wired yet — Korean pools stay empty and say so.

Rules: a flow is drawn only where a source *measures* it. Pool sizes are official levels; anything estimated
(weekly values between quarterly releases, gold stock, bitcoin supply) is flagged `estimate` with the reason.
"""
from __future__ import annotations

import csv
import io
import json
import math
import os
import sys
import time
import zipfile
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import httpx
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "data" / "money_cache"
OUT = ROOT / "web" / "money" / "data.json"
START = pd.Timestamp("2006-11-03")          # first Friday of the 20-year window
UA = {"User-Agent": "Mozilla/5.0 (market-organism money map; research)"}
http = httpx.Client(timeout=90, follow_redirects=True, headers=UA)


# ------------------------------------------------------------------ fetchers
def fred(sid: str) -> pd.Series:
    t = http.get("https://fred.stlouisfed.org/graph/fredgraph.csv", params={"id": sid}).text
    rows = [r for r in csv.reader(io.StringIO(t))][1:]
    rows = [(r[0], float(r[1])) for r in rows if len(r) > 1 and r[1] not in (".", "")]
    if not rows:
        raise RuntimeError(f"FRED {sid}: no rows")
    s = pd.Series([v for _, v in rows], index=pd.to_datetime([d for d, _ in rows]), name=sid)
    return s


def z1_package() -> Path:
    CACHE.mkdir(parents=True, exist_ok=True)
    z = CACHE / "z1_csv_files.zip"
    if not z.exists() or time.time() - z.stat().st_mtime > 7 * 86400:
        r = http.get("https://www.federalreserve.gov/releases/z1/current/z1_csv_files.zip")
        r.raise_for_status()
        z.write_bytes(r.content)
    return z


_z1 = {}
def z1(code: str) -> pd.Series:
    """Quarterly Z.1 series, e.g. 'FA153064105.Q'. Index = quarter-end dates. Units: $ millions."""
    if not _z1:
        with zipfile.ZipFile(z1_package()) as zf:
            for name in zf.namelist():
                if not name.startswith("csv/") or not name.endswith(".csv"):
                    continue
                df = pd.read_csv(zf.open(name), dtype=str)
                if "date" not in df.columns or not df["date"].str.contains(":Q").any():
                    continue
                for col in df.columns[1:]:
                    if col not in _z1:
                        _z1[col] = df[["date", col]]
    if code not in _z1:
        raise KeyError(code)
    df = _z1[code]
    vals = pd.to_numeric(df[code], errors="coerce")
    idx = [pd.Period(d.replace(":", ""), freq="Q").end_time.normalize() for d in df["date"]]
    return pd.Series(vals.values, index=pd.DatetimeIndex(idx), name=code).dropna()


def yahoo(tickers: list[str]) -> pd.DataFrame:
    import yfinance as yf
    d = yf.download(tickers, start="2006-06-01", interval="1d", progress=False, auto_adjust=True, threads=True)
    return d["Close"]


def stablecoins() -> pd.Series:
    r = http.get("https://stablecoins.llama.fi/stablecoincharts/all").json()
    idx = pd.to_datetime([int(x["date"]) for x in r], unit="s")
    v = [sum((x.get("totalCirculatingUSD") or {}).values()) for x in r]
    return pd.Series(v, index=idx, name="stablecoins")


# ------------------------------------------------------------------ weekly grid helpers
def weekly_grid(end: pd.Timestamp) -> pd.DatetimeIndex:
    return pd.date_range(START, end, freq="W-FRI")


def to_weekly_last(s: pd.Series, W: pd.DatetimeIndex, max_gap_days=45) -> pd.Series:
    """Last observation on or before each Friday (no look-ahead); null if the last one is too old."""
    s = s.dropna().sort_index()
    pos = s.index.searchsorted(W, side="right") - 1
    out = []
    for w, p in zip(W, pos):
        if p < 0 or (w - s.index[p]).days > max_gap_days:
            out.append(np.nan)
        else:
            out.append(s.iloc[p])
    return pd.Series(out, index=W)


def interp_quarterly(q: pd.Series, W: pd.DatetimeIndex, price: pd.Series | None = None):
    """Weekly values between official quarter-end levels.
    Without a price series: linear between quarter-ends. With one: scale by the price ratio, then correct the drift
    so both official endpoints are hit exactly. After the last official quarter: price-scaled (if price) else null.
    Returns (values, is_estimate[bool per week])."""
    q = q.dropna().sort_index()
    vals, est = [], []
    for w in W:
        k = q.index.searchsorted(w, side="right") - 1
        if k < 0:
            vals.append(np.nan); est.append(True); continue
        t0, v0 = q.index[k], q.iloc[k]
        if w == t0:
            vals.append(v0); est.append(False); continue
        if k + 1 < len(q):
            t1, v1 = q.index[k + 1], q.iloc[k + 1]
            f = (w - t0) / (t1 - t0)
            if price is not None:
                p0, p1, pw = price.asof(t0), price.asof(t1), price.asof(w)
                if all(np.isfinite([p0, p1, pw])) and p0 > 0:
                    base = v0 * pw / p0
                    drift = (v1 / (v0 * p1 / p0)) if p1 > 0 else 1
                    vals.append(base * (1 + f * (drift - 1))); est.append(True); continue
            vals.append(v0 + f * (v1 - v0)); est.append(True)
        else:
            if price is not None:
                p0, pw = price.asof(t0), price.asof(w)
                if np.isfinite(p0) and np.isfinite(pw) and p0 > 0 and (w - t0).days < 200:
                    vals.append(v0 * pw / p0); est.append(True); continue
            vals.append(v0 if (w - t0).days < 200 else np.nan); est.append(True)   # after the last release: hold it
    return pd.Series(vals, index=W), est


def quarterly_flow_weekly(fa: pd.Series, W: pd.DatetimeIndex) -> pd.Series:
    """Z.1 transactions (seasonally adjusted annual rate, $M) -> $ per week, spread evenly over the quarter's weeks.
    Weeks after the last published quarter stay null (not drawn)."""
    fa = fa.dropna().sort_index()
    out = []
    for w in W:
        k = fa.index.searchsorted(w, side="left")         # quarter that contains w ends at fa.index[k]
        if k >= len(fa):
            out.append(np.nan); continue
            # (no published quarter yet)
        qe = fa.index[k]
        qs = (qe - pd.offsets.QuarterBegin(startingMonth=1)).normalize() if qe.month in (3, 6, 9, 12) else qe
        if w < qs - pd.Timedelta(days=1):
            out.append(np.nan); continue
        out.append(fa.iloc[k] / 4 / 13)                     # quarterly amount spread over ~13 weeks
    return pd.Series(out, index=W)


def btc_supply(d: pd.Timestamp) -> float:
    """Issued BTC from the protocol schedule (≈144 blocks/day); accurate to well under 1 % for this purpose."""
    halv = [(pd.Timestamp("2009-01-03"), 0.0, 50.0), (pd.Timestamp("2012-11-28"), 10_500_000, 25.0),
            (pd.Timestamp("2016-07-09"), 15_750_000, 12.5), (pd.Timestamp("2020-05-11"), 18_375_000, 6.25),
            (pd.Timestamp("2024-04-20"), 19_687_500, 3.125)]
    t0, s0, rw = [h for h in halv if h[0] <= d][-1]
    return min(s0 + rw * 144 * (d - t0).days, 21e6)


def rolling_corr(a: pd.Series, b: pd.Series, n=13) -> pd.Series:
    ra, rb = np.log(a).diff(), np.log(b).diff()
    return ra.rolling(n, min_periods=n).corr(rb)


def r1(x, nd=1):
    return None if x is None or not np.isfinite(x) else round(float(x), nd)


# ------------------------------------------------------------------ build
def main() -> int:
    t_start = time.time()
    log = lambda *a: print(*a, flush=True)
    log("fetching Yahoo prices …")
    PX = {"spx": "^GSPC", "tlt": "TLT", "ief": "IEF", "lqd": "LQD", "gold": "GC=F", "oil": "CL=F", "reit": "VNQ",
          "btc": "BTC-USD", "kospi": "^KS11", "dxy": "DX-Y.NYB", "usdkrw": "KRW=X", "em": "EEM"}
    px_d = yahoo(list(PX.values()))
    end = px_d.index.max().normalize()
    W = weekly_grid(end)
    log(f"  weeks: {W[0].date()} → {W[-1].date()} ({len(W)})")
    px = {k: to_weekly_last(px_d[t], W, 10) for k, t in PX.items()}

    log("fetching FRED …")
    F = {}
    for sid in ["DPSACBW027SBOG", "CPIAUCSL", "DFF", "DGS10", "BAA10Y", "DCOILWTICO", "WALCL", "RRPONTSYD", "M2SL",
                "IRSTCI01KRM156N", "IRLTLT01KRM156N", "CPALTT01KRM659N"]:
        try:
            F[sid] = fred(sid)
        except Exception as e:
            log(f"  FRED {sid} failed: {e}")
    log("loading Z.1 …")
    Z = {}
    for code in ["FL634090005.Q", "FL893061105.Q", "FL893061705.Q", "FL893063005.Q", "LM893064105.Q", "LM155035005.Q",
                 "FA153020005.Q", "FA153030005.Q", "FA153034005.Q", "FA153061105.Q", "FA153063005.Q", "FA153064105.Q",
                 "FA153064205.Q", "FA263061105.Q", "FA263064105.Q", "FA713061103.Q", "FA713061705.Q"]:
        try:
            Z[code] = z1(code)
        except Exception as e:
            log(f"  Z.1 {code} missing: {e}")
    z1_last = max(s.index.max() for s in Z.values())
    log(f"  Z.1 latest quarter: {z1_last.date()}")
    log("fetching stablecoins …")
    try:
        stable = stablecoins()
    except Exception as e:
        stable = None; log(f"  stablecoins failed: {e}")

    B = 1e3   # Z.1 is $ millions -> $ billions
    pools, flows, lanes, links = [], [], [], []

    def pool(id, label, group, values, est, src, note="", kind="pool"):
        pools.append({"id": id, "label": label, "group": group, "kind": kind, "src": src, "note": note,
                      "v": [r1(x, 1) for x in values], "est": [1 if e else 0 for e in est] if est is not None else None})

    # ---- cash
    dep = to_weekly_last(F["DPSACBW027SBOG"], W, 21)
    pool("deposits", "Bank deposits", "cash", dep.values, [False] * len(W), "FRED DPSACBW027SBOG (H.8, weekly, all US commercial banks)")
    mmf, e = interp_quarterly(Z["FL634090005.Q"] / B, W)
    pool("mmf", "Money market funds", "cash", mmf.values, e, "Fed Z.1 FL634090005 (MMF total assets, quarterly)",
         "weekly values are interpolated between official quarters")
    # ---- bonds
    for id, code, label, priceK in [("treasuries", "FL893061105.Q", "US Treasuries", None),
                                   ("mbs", "FL893061705.Q", "Mortgage (agency) bonds", None),
                                   ("corpbonds", "FL893063005.Q", "Corporate bonds", None)]:
        s, e = interp_quarterly(Z[code] / B, W)
        pool(id, label, "bonds", s.values, e, f"Fed Z.1 {code.split('.')[0]} (amount outstanding, quarterly)",
             "weekly values are interpolated between official quarters" + ("; includes foreign bonds held in the US" if id == "corpbonds" else ""))
    # ---- stocks
    eq, e = interp_quarterly(Z["LM893064105.Q"] / B, W, price=px["spx"])
    pool("stocks", "Stocks (all US-held)", "stocks", eq.values, e, "Fed Z.1 LM893064105 (all sectors; corporate equities; market value, quarterly)",
         "includes private companies at market value and foreign stock held by US investors, so it is about twice the listed US market cap. "
         "Between quarters: scaled by the S&P 500 and corrected to hit each official quarter")
    pool("kospi", "Korea stocks", "stocks", [None] * len(W), None, "needs Bank of Korea ECOS key (ECOS_API_KEY)",
         "size not available without ECOS — KOSPI price still drives co-movement links", kind="price")
    # ---- real assets
    re_, e = interp_quarterly(Z["LM155035005.Q"] / B, W)
    pool("realestate", "US real estate (households)", "real", re_.values, e, "Fed Z.1 LM155035005 (market value, quarterly)",
         "weekly values are interpolated between official quarters")
    # tonnes above ground: World Gold Council end-2023 figure, moved back/forward by ~3,000 t/yr of mine supply (estimate)
    yrs = (W - pd.Timestamp("2023-12-31")).days / 365.25
    tonnes = 212_582 + 3_000 * np.asarray(yrs, dtype=float)
    gold = px["gold"] * tonnes * 32_150.7 / 1e9
    pool("gold", "Gold (world stock)", "real", gold.values, [True] * len(W),
         "COMEX gold price × WGC above-ground stock (212.6 kt at end-2023, ±~3,000 t/yr mine supply)",
         "estimate: tonnage is approximate; almost all of the change you see is the gold price")
    pool("oil", "Oil", "real", [None] * len(W), None, "WTI price (no 'amount' exists for oil)", "price only", kind="price")
    # ---- crypto
    btc = pd.Series([p * btc_supply(w) / 1e9 if np.isfinite(p) else np.nan for w, p in zip(W, px["btc"].values)], index=W)
    pool("bitcoin", "Bitcoin", "crypto", btc.values, [True] * len(W), "BTC-USD price × issued supply (protocol schedule)",
         "supply computed from the issuance schedule (±0.5 %)")
    if stable is not None:
        st = to_weekly_last(stable / 1e9, W, 10)
        pool("stable", "Stablecoins", "crypto", st.values, [False] * len(W), "DefiLlama total stablecoin supply (daily)")

    # ---- hubs (who moves money) + measured flows
    hubs = [{"id": "households", "label": "US households", "src": "Fed Z.1 sector 15 (households & nonprofits)"},
            {"id": "foreign", "label": "Foreign investors", "src": "Fed Z.1 sector 26 (rest of the world)"},
            {"id": "fed", "label": "Federal Reserve", "src": "Fed Z.1 sector 71 (central bank)"}]

    def flow(id, frm, to, label, series, src, note=""):
        flows.append({"id": id, "from": frm, "to": to, "label": label, "src": src, "note": note,
                      "w": [r1(x / B, 2) if np.isfinite(x) else None for x in series.values]})

    def zf(code):
        return Z.get(code, pd.Series(dtype=float))

    hh_dep = zf("FA153020005.Q").add(zf("FA153030005.Q"), fill_value=0)
    QN = "official quarterly net purchases (Z.1 transactions, seasonally adjusted), spread over the quarter's weeks"
    flow("hh_dep", "households", "deposits", "Households → deposits", quarterly_flow_weekly(hh_dep, W), "Z.1 FA153020005 + FA153030005", QN)
    flow("hh_mmf", "households", "mmf", "Households → money market funds", quarterly_flow_weekly(zf("FA153034005.Q"), W), "Z.1 FA153034005", QN)
    flow("hh_ust", "households", "treasuries", "Households → Treasuries", quarterly_flow_weekly(zf("FA153061105.Q"), W), "Z.1 FA153061105", QN)
    flow("hh_corp", "households", "corpbonds", "Households → corporate bonds", quarterly_flow_weekly(zf("FA153063005.Q"), W), "Z.1 FA153063005", QN)
    flow("hh_eq", "households", "stocks", "Households → stocks (direct)", quarterly_flow_weekly(zf("FA153064105.Q"), W), "Z.1 FA153064105", QN)
    flow("hh_funds", "households", "stocks", "Households → mutual funds", quarterly_flow_weekly(zf("FA153064205.Q"), W), "Z.1 FA153064205",
         QN + "; funds hold both stocks and bonds")
    flow("row_ust", "foreign", "treasuries", "Foreigners → Treasuries", quarterly_flow_weekly(zf("FA263061105.Q"), W), "Z.1 FA263061105", QN)
    flow("row_eq", "foreign", "stocks", "Foreigners → US stocks", quarterly_flow_weekly(zf("FA263064105.Q"), W), "Z.1 FA263064105", QN)
    flow("fed_ust", "fed", "treasuries", "Fed → Treasuries (QE / QT)", quarterly_flow_weekly(zf("FA713061103.Q"), W), "Z.1 FA713061103", QN)
    flow("fed_mbs", "fed", "mbs", "Fed → mortgage bonds (QE / QT)", quarterly_flow_weekly(zf("FA713061705.Q"), W), "Z.1 FA713061705", QN)
    if stable is not None:
        st_d = (stable / 1e9).resample("W-FRI").last().reindex(W).diff()
        flows.append({"id": "cash_stable", "from": "deposits", "to": "stable", "label": "Dollars → stablecoins (net minting)",
                      "src": "DefiLlama total stablecoin supply, weekly change", "note": "measured weekly",
                      "w": [r1(x, 2) if np.isfinite(x) else None for x in st_d.values]})

    # ---- driver lanes ("why" context on the same time axis)
    def lane(id, label, unit, s, src, fmt=2, group="us"):
        lanes.append({"id": id, "label": label, "unit": unit, "src": src, "group": group,
                      "v": [r1(x, fmt) for x in s.values]})
    cpi = F["CPIAUCSL"]; cpi_yoy = (cpi / cpi.shift(12) - 1) * 100
    lane("cpi", "US inflation (CPI, y/y)", "%", to_weekly_last(cpi_yoy, W, 70), "FRED CPIAUCSL")
    lane("ff", "Fed policy rate", "%", to_weekly_last(F["DFF"], W, 10), "FRED DFF")
    lane("y10", "US 10-year yield", "%", to_weekly_last(F["DGS10"], W, 10), "FRED DGS10")
    lane("credit", "Credit spread (Baa − 10y)", "pp", to_weekly_last(F["BAA10Y"], W, 10), "FRED BAA10Y")
    lane("oilp", "Oil (WTI)", "$", px["oil"], "Yahoo CL=F", 1)
    lane("dxy", "Dollar index", "", px["dxy"], "Yahoo DX-Y.NYB", 1)
    lane("fedbs", "Fed balance sheet", "$T", to_weekly_last(F["WALCL"] / 1e6, W, 10), "FRED WALCL")
    lane("rrp", "Fed reverse repo (parked cash)", "$T", to_weekly_last(F["RRPONTSYD"] / 1e3, W, 10), "FRED RRPONTSYD")
    m2 = F["M2SL"]; lane("m2", "US money supply M2 (y/y)", "%", to_weekly_last((m2 / m2.shift(12) - 1) * 100, W, 70), "FRED M2SL")
    lane("usdkrw", "USD/KRW", "₩", px["usdkrw"], "Yahoo KRW=X", 0, "kr")
    if "IRSTCI01KRM156N" in F: lane("krrate", "Korea call rate", "%", to_weekly_last(F["IRSTCI01KRM156N"], W, 70), "FRED/OECD IRSTCI01KRM156N", 2, "kr")
    if "IRLTLT01KRM156N" in F: lane("kr10", "Korea 10-year yield", "%", to_weekly_last(F["IRLTLT01KRM156N"], W, 70), "FRED/OECD IRLTLT01KRM156N", 2, "kr")
    if "CPALTT01KRM659N" in F: lane("krcpi", "Korea inflation (CPI, y/y)", "%", to_weekly_last(F["CPALTT01KRM659N"], W, 70), "FRED/OECD CPALTT01KRM659N (ends 2023-11)", 2, "kr")
    lane("kospi", "KOSPI", "", px["kospi"], "Yahoo ^KS11", 0, "kr")

    # ---- co-movement links (13-week rolling correlation of weekly returns)
    LP = {"stocks": "spx", "treasuries": "tlt", "corpbonds": "lqd", "gold": "gold", "oil": "oil", "realestate": "reit",
          "bitcoin": "btc", "kospi": "kospi"}
    keys = list(LP)
    for i in range(len(keys)):
        for j in range(i + 1, len(keys)):
            a, b = keys[i], keys[j]
            cr = rolling_corr(px[LP[a]], px[LP[b]])
            links.append({"a": a, "b": b, "c": [r1(x, 2) for x in cr.values]})

    # ---- events: weeks with the biggest 4-week moves vs each series' own history (data only, no labels invented)
    MOV = {"US stocks": px["spx"], "Long Treasuries": px["tlt"], "Gold": px["gold"], "Oil": px["oil"], "Bitcoin": px["btc"],
           "KOSPI": px["kospi"], "Dollar": px["dxy"]}
    z = {}
    for k, s in MOV.items():
        r4 = np.log(s).diff(4)
        z[k] = r4 / r4.std()
    Zdf = pd.DataFrame(z)
    score = Zdf.abs().max(axis=1).fillna(0)
    events, taken = [], []
    for w in score.sort_values(ascending=False).index:
        if len(events) >= 16: break
        if any(abs((w - t).days) < 180 for t in taken): continue
        taken.append(w)
        row = Zdf.loc[w].dropna().abs().sort_values(ascending=False).index[:3]
        moves = [{"k": k, "pct": r1((math.exp(np.log(MOV[k]).diff(4).loc[w]) - 1) * 100, 1)} for k in row]
        y = {}
        for lid, s in [("ff", "DFF"), ("y10", "DGS10")]:
            ser = to_weekly_last(F[s], W, 10)
            y[lid] = r1(ser.loc[w] - ser.shift(4).loc[w], 2)
        events.append({"t": int(w.timestamp() * 1000), "moves": moves, "rates": y, "score": r1(score.loc[w], 1)})
    events.sort(key=lambda e: e["t"])

    meta = {"built_at": int(time.time() * 1000), "from": int(W[0].timestamp() * 1000), "to": int(W[-1].timestamp() * 1000),
            "n": len(W), "unit": "USD billions", "z1_latest": str(z1_last.date()),
            "korea": "Korean pool sizes need a Bank of Korea ECOS key; Korean prices, rates and FX are included.",
            "rules": ["Flows are drawn only where a source measures them (Z.1 transactions, stablecoin supply).",
                      "Pool sizes are official levels; weekly values between quarterly releases are marked estimate.",
                      "Co-movement links are 13-week correlations of weekly returns — they show moving together, not cause."]}
    data = {"meta": meta, "weeks": [int(w.timestamp() * 1000) for w in W], "pools": pools, "hubs": hubs, "flows": flows,
            "lanes": lanes, "links": links, "events": events}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    log(f"wrote {OUT.relative_to(ROOT)} · {OUT.stat().st_size / 1e6:.2f} MB · {len(pools)} pools · {len(flows)} flows · "
        f"{len(lanes)} lanes · {len(links)} links · {len(events)} events · {time.time() - t_start:.0f}s")
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())
