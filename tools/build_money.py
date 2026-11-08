"""Money Map data builder: 20 years of where money sits and where it moves, from official / market data only.

    python tools/build_money.py            # -> web/money/data.json (US) and, with ECOS_API_KEY, web/money/data_kr.json

Sources (all public, no key unless noted):
  * Federal Reserve Z.1 Financial Accounts (CSV package): quarterly amounts outstanding and *transactions*
    (actual net purchases) by sector — households, rest of world (foreigners), the Fed.
  * FRED (fredgraph.csv): weekly bank deposits, CPI, Fed funds, 10y yield, credit spread, oil, Fed balance sheet,
    reverse repo, M2, Korea rates (OECD).
  * Yahoo Finance via yfinance: weekly prices for co-movement and for nowcasting equity value between quarters.
  * DefiLlama: total stablecoin supply (daily).
  * Bank of Korea ECOS (needs ECOS_API_KEY, free at ecos.bok.or.kr): Korean flow of funds (levels + transactions),
    KOSPI/KOSDAQ market cap, KRX investor net buying, housing market value, base rate, KTB yields, CPI.
    Without the key the Korea view is simply not built (the page says so).

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
OUT_KR = ROOT / "web" / "money" / "data_kr.json"
ECOS_KEY = os.environ.get("ECOS_API_KEY", "").strip()    # never written to disk or logs
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


def _period_end(t: str, cycle: str) -> pd.Timestamp:
    if cycle == "A":
        return pd.Timestamp(f"{t}-12-31")
    if cycle == "Q":
        return pd.Period(t, freq="Q").end_time.normalize()
    if cycle == "M":
        return pd.Period(f"{t[:4]}-{t[4:6]}", freq="M").end_time.normalize()
    return pd.Timestamp(t)                                                   # D: YYYYMMDD


def ecos(stat: str, cycle: str, start: str, end: str, *items: str) -> pd.Series:
    """One Bank of Korea ECOS series (StatisticSearch). Index = period-end dates; values in the published unit.
    Responses are cached for a day under data/money_cache/ecos (data only; the key is never stored)."""
    if not ECOS_KEY:
        raise RuntimeError("ECOS_API_KEY not set")
    cdir = CACHE / "ecos"
    cdir.mkdir(parents=True, exist_ok=True)
    f = cdir / ("_".join((stat, cycle, start, end) + items) + ".json")
    if f.exists() and time.time() - f.stat().st_mtime < 86400:
        rows = json.loads(f.read_text(encoding="utf-8"))
    else:
        url = f"https://ecos.bok.or.kr/api/StatisticSearch/{ECOS_KEY}/json/kr/1/100000/{stat}/{cycle}/{start}/{end}/" + "/".join(items)
        try:
            d = http.get(url).json()
        except Exception as e:                                               # keep the key out of any message
            raise RuntimeError(f"ECOS {stat} {'/'.join(items)}: {type(e).__name__}: {str(e).replace(ECOS_KEY, '***')}") from None
        res = d.get("StatisticSearch")
        if not res:
            msg = (d.get("RESULT") or {}).get("MESSAGE", str(d))[:160]
            raise RuntimeError(f"ECOS {stat} {'/'.join(items)}: {msg}")
        rows = [[r["TIME"], r["DATA_VALUE"]] for r in res.get("row", [])]
        f.write_text(json.dumps(rows), encoding="utf-8")
    vals = [(_period_end(t, cycle), float(v)) for t, v in rows if v not in (None, "", "-")]
    if not vals:
        raise RuntimeError(f"ECOS {stat} {'/'.join(items)}: no rows")
    return pd.Series([v for _, v in vals], index=pd.DatetimeIndex([t for t, _ in vals]), name=stat).sort_index()


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


def interp_quarterly(q: pd.Series, W: pd.DatetimeIndex, price: pd.Series | None = None, hold_days: int = 200):
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
                if np.isfinite(p0) and np.isfinite(pw) and p0 > 0 and (w - t0).days < hold_days:
                    vals.append(v0 * pw / p0); est.append(True); continue
            vals.append(v0 if (w - t0).days < hold_days else np.nan); est.append(True)   # after the last release: hold it
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


def period_flow_weekly(s: pd.Series, W: pd.DatetimeIndex, freq: str) -> pd.Series:
    """Amounts measured per period (s indexed by period-end) -> per week. Quarterly: amount / 13 (so 13 weeks give the
    quarter back); monthly: amount / number of Fridays in that month. Periods not published yet stay null."""
    s = s.dropna().sort_index()
    per = W.to_period(freq)
    n = pd.Series(per).value_counts()
    out = []
    for p in per:
        pe = p.end_time.normalize()
        out.append(s.loc[pe] / (13 if freq == "Q" else n[p]) if pe in s.index else np.nan)
    return pd.Series(out, index=W)


def splice_back(new: pd.Series, old):
    """Extend a series back with an older statistical basis, scaled to match at the first new observation."""
    new = new.dropna().sort_index()
    t0 = new.index.min()
    if old is None or old.empty or t0 not in old.index or not old.loc[t0]:
        return new, t0
    pre = old[old.index < t0] * (new.loc[t0] / old.loc[t0])
    return pd.concat([pre, new]).sort_index(), t0


def make_events(MOV: dict, rate_series: dict, W) -> list:
    """Weeks with the biggest 4-week moves vs each series' own history (data only, no labels invented)."""
    z = {}
    for k, s in MOV.items():
        r4 = np.log(s).diff(4)
        z[k] = r4 / r4.std()
    Zdf = pd.DataFrame(z)
    score = Zdf.abs().max(axis=1).fillna(0)
    events, taken = [], []
    for w in score.sort_values(ascending=False).index:
        if len(events) >= 16:
            break
        if any(abs((w - t).days) < 180 for t in taken):
            continue
        taken.append(w)
        row = Zdf.loc[w].dropna().abs().sort_values(ascending=False).index[:3]
        moves = [{"k": k, "pct": r1((math.exp(np.log(MOV[k]).diff(4).loc[w]) - 1) * 100, 1)} for k in row]
        y = {lid: r1(ser.loc[w] - ser.shift(4).loc[w], 2) for lid, ser in rate_series.items()}
        events.append({"t": int(w.timestamp() * 1000), "moves": moves, "rates": y, "score": r1(score.loc[w], 1)})
    events.sort(key=lambda e: e["t"])
    return events


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

    def pool(id, label, group, values, est, src, note="", kind="pool", lane=None):
        pools.append({"id": id, "label": label, "group": group, "kind": kind, "src": src, "note": note, "lane": lane,
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
    pool("kospi", "Korea stocks (KOSPI)", "stocks", [None] * len(W), None, "Yahoo ^KS11 (price)",
         "price only here; Korean pool sizes are in the Korea view", kind="price", lane="kospi")
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
    pool("oil", "Oil", "real", [None] * len(W), None, "WTI price (no 'amount' exists for oil)", "price only", kind="price", lane="oilp")
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
        flows.append({"id": id, "from": frm, "to": to, "label": label, "src": src, "note": note, "per": "q",
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
                      "src": "DefiLlama total stablecoin supply, weekly change", "note": "measured weekly", "per": "w",
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
    lane("spxp", "S&P 500", "", px["spx"], "Yahoo ^GSPC", 0, "world")
    lane("goldp", "Gold ($/oz)", "$", px["gold"], "Yahoo GC=F", 0, "world")
    lane("btcp", "Bitcoin ($)", "$", px["btc"], "Yahoo BTC-USD", 0, "world")

    # ---- co-movement links (13-week rolling correlation of weekly returns)
    LP = {"stocks": "spx", "treasuries": "tlt", "corpbonds": "lqd", "gold": "gold", "oil": "oil", "realestate": "reit",
          "bitcoin": "btc", "kospi": "kospi"}
    keys = list(LP)
    for i in range(len(keys)):
        for j in range(i + 1, len(keys)):
            a, b = keys[i], keys[j]
            cr = rolling_corr(px[LP[a]], px[LP[b]])
            links.append({"a": a, "b": b, "c": [r1(x, 2) for x in cr.values]})

    # ---- events: weeks with the biggest 4-week moves vs each series' own history
    MOV = {"US stocks": px["spx"], "Long Treasuries": px["tlt"], "Gold": px["gold"], "Oil": px["oil"], "Bitcoin": px["btc"],
           "KOSPI": px["kospi"], "Dollar": px["dxy"]}
    events = make_events(MOV, {"ff": to_weekly_last(F["DFF"], W, 10), "y10": to_weekly_last(F["DGS10"], W, 10)}, W)

    meta = {"built_at": int(time.time() * 1000), "from": int(W[0].timestamp() * 1000), "to": int(W[-1].timestamp() * 1000),
            "n": len(W), "unit": "USD billions", "cur": "$", "region": "us", "rscale": 0.042,
            "z1_latest": str(z1_last.date()), "flows_name": "The Fed's Financial Accounts (Z.1)",
            "rate_labels": {"ff": "Fed rate", "y10": "US 10y yield"},
            "rules": ["Flows are drawn only where a source measures them (Z.1 transactions, stablecoin supply).",
                      "Pool sizes are official levels; weekly values between quarterly releases are marked estimate.",
                      "Co-movement links are 13-week correlations of weekly returns — they show moving together, not cause."]}
    data = {"meta": meta, "weeks": [int(w.timestamp() * 1000) for w in W], "pools": pools, "hubs": hubs, "flows": flows,
            "lanes": lanes, "links": links, "events": events}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    log(f"wrote {OUT.relative_to(ROOT)} · {OUT.stat().st_size / 1e6:.2f} MB · {len(pools)} pools · {len(flows)} flows · "
        f"{len(lanes)} lanes · {len(links)} links · {len(events)} events · {time.time() - t_start:.0f}s")
    if ECOS_KEY:
        build_korea(W, px, F, lanes, log)
    else:
        log("Korea view skipped: set ECOS_API_KEY (free key from ecos.bok.or.kr) to build web/money/data_kr.json")
    return 0


# ------------------------------------------------------------------ Korea (Bank of Korea ECOS; KRX data via ECOS)
def build_korea(W, px, F, us_lanes, log) -> None:
    t0 = time.time()
    log("Korea: fetching ECOS …")
    yq, ym = f"{W[-1].year}Q4", f"{W[-1].year}12"
    FL, FT = "281Y002", "281Y001"            # flow of funds (2008~): amounts outstanding / financial transactions

    def lvl(sec, item, al):                  # 십억원 (KRW billions)
        return ecos(FL, "Q", "2008Q4", yq, sec, item, al)

    def trx(sec, item, cd):                  # 십억원 per quarter (C = use of funds, D = source of funds)
        return ecos(FT, "Q", "2009Q1", yq, sec, item, cd)

    def old(sec, item, al):                  # older 2002~2013 basis, only for splicing 2006-2008
        return ecos("281Y007", "Q", "2005Q1", "2013Q4", item, al, sec)       # this older table orders items differently

    def krx(who):                            # 백만원 -> 십억원 per month
        return ecos("901Y055", "M", "200601", ym, who, "VA") / 1e3

    pools, flows, links = [], [], []

    def pool(id, label, group, values, est, src, note="", kind="pool", lane=None):
        pools.append({"id": id, "label": label, "group": group, "kind": kind, "src": src, "note": note, "lane": lane,
                      "v": [r1(x, 0) for x in values], "est": [1 if e else 0 for e in est] if est is not None else None})

    def flow(id, frm, to, label, series, src, note, per):
        flows.append({"id": id, "from": frm, "to": to, "label": label, "src": src, "note": note, "per": per,
                      "w": [r1(x, 2) if np.isfinite(x) else None for x in series.values]})

    def spliced(new, older):
        q, t_new = splice_back(new, older)
        v, e = interp_quarterly(q, W)
        e = [True if w < t_new else x for w, x in zip(W, e)]
        return v, e, f"before {t_new.year} Q{(t_new.month - 1) // 3 + 1}: older 2002~2013 basis scaled to match"

    def try_old(*a):
        try:
            return old(*a)
        except Exception as e:
            log(f"  old-basis series unavailable: {e}")
            return None

    # ---- pools (KRW billions)
    dep, e, sn = spliced(lvl("S122", "F02TZB", "L"), try_old("C1200", "302000", "L"))
    pool("deposits", "Deposits (banks & non-banks)", "cash", dep.values, e,
         "BoK flow of funds 281Y002: deposit-taking corporations (S122), cash & deposits, liabilities (quarterly)",
         "weekly values interpolated between quarters; " + sn)
    pool("usd", "Dollar (USD/KRW)", "cash", [None] * len(W), None, "Yahoo KRW=X", "price: won per dollar (up = weaker won)",
         kind="price", lane="usdkrw")
    bd, e, sn = spliced(lvl("S1", "F04TTB", "L"), try_old("C0000", "304000", "L"))
    pool("bonds", "Korean bonds (all issuers)", "bonds", bd.values, e,
         "BoK flow of funds 281Y002: domestic sectors (S1), bonds, liabilities (quarterly)",
         "government, BoK (MSB), bank, corporate and asset-backed bonds; weekly values interpolated; " + sn)
    house = ecos("291Y524", "A", "2005", str(W[-1].year), "REG00")
    hv, e = interp_quarterly(house, W, hold_days=400)
    pool("housing", "Housing (all Korea)", "real", hv.values, e,
         "BoK national balance sheet 291Y524: market value of all dwellings (year-end)",
         "annual figure; weeks in between are interpolated, and the last year-end is held")
    pool("gold", "Gold", "real", [None] * len(W), None, "Yahoo GC=F", "price only ($/oz)", kind="price", lane="goldp")
    cap = (ecos("901Y014", "M", "200501", ym, "1040000") + ecos("901Y014", "M", "200501", ym, "2040000")) / 1e6
    cv, e = interp_quarterly(cap.dropna(), W, price=px["kospi"])
    pool("stocks", "Listed stocks (KOSPI + KOSDAQ)", "stocks", cv.values, e,
         "ECOS 901Y014: KOSPI + KOSDAQ market capitalisation (month-end)",
         "between month-ends: scaled by the KOSPI index and corrected to hit each official month-end")
    pool("spx", "US stocks (S&P 500)", "stocks", [None] * len(W), None, "Yahoo ^GSPC", "price only", kind="price", lane="spxp")
    pool("btc", "Bitcoin", "crypto", [None] * len(W), None, "Yahoo BTC-USD", "price only ($)", kind="price", lane="btcp")

    hubs = [{"id": "households", "label": "Korean households", "src": "BoK flow of funds sector S14; KRX individual investors"},
            {"id": "foreign", "label": "Foreign investors", "src": "BoK flow of funds sector S2 (rest of the world); KRX foreigners"},
            {"id": "inst", "label": "Institutions", "src": "KRX institutional investors (pension funds, asset managers, banks, insurers)"},
            {"id": "bok", "label": "Bank of Korea", "src": "BoK flow of funds sector S121"}]
    QN = "BoK flow of funds transactions (281Y001, quarterly, not annualised), spread over the quarter's weeks"
    MN = ("KRX net buying by investor type (ECOS 901Y055, KOSPI market, monthly); the panel shows the last 13 weeks. "
          "One group's net buying is another's net selling: it shows who is buying, not new money")
    flow("hh_dep", "households", "deposits", "Households → deposits", period_flow_weekly(trx("S14", "F02TZB", "C"), W, "Q"),
         "281Y001 S14 F02TZB (use of funds)", QN, "q")
    flow("hh_bond", "households", "bonds", "Households → bonds", period_flow_weekly(trx("S14", "F04TTB", "C"), W, "Q"),
         "281Y001 S14 F04TTB (use of funds)", QN, "q")
    flow("hh_loan", "deposits", "households", "Loans → households", period_flow_weekly(trx("S14", "F05TTB", "D"), W, "Q"),
         "281Y001 S14 F05TTB (source of funds)", QN + "; net new loans taken by households, from all lenders", "q")
    flow("for_bond", "foreign", "bonds", "Foreign → Korean bonds", period_flow_weekly(trx("S2", "F04TTB", "C"), W, "Q"),
         "281Y001 S2 F04TTB (use of funds)", QN, "q")
    flow("bok_bond", "bok", "bonds", "Bank of Korea → bonds", period_flow_weekly(trx("S121", "F04TTB", "C"), W, "Q"),
         "281Y001 S121 F04TTB (use of funds)", QN, "q")
    flow("ind_stk", "households", "stocks", "Individuals → stocks", period_flow_weekly(krx("S22CB"), W, "M"),
         "901Y055 S22CB (individuals, net buying value)", MN, "m")
    flow("for_stk", "foreign", "stocks", "Foreign → stocks", period_flow_weekly(krx("S22CC"), W, "M"),
         "901Y055 S22CC (foreigners, net buying value)", MN, "m")
    flow("inst_stk", "inst", "stocks", "Institutions → stocks", period_flow_weekly(krx("S22CA"), W, "M"),
         "901Y055 S22CA (institutions, net buying value)", MN, "m")

    # ---- lanes: the US set plus ECOS Korea drivers (replacing the OECD copies, which stop earlier)
    lanes = [l for l in us_lanes if l["id"] not in ("krrate", "kr10", "krcpi")]

    def lane(id, label, unit, s, src, nd=2):
        lanes.append({"id": id, "label": label, "unit": unit, "src": src, "group": "kr", "v": [r1(x, nd) for x in s.values]})

    base = ecos("722Y001", "D", "20060101", f"{W[-1].year}1231", "0101000")
    base_w = to_weekly_last(base, W, 4000)
    lane("krrate", "BoK base rate", "%", base_w, "ECOS 722Y001 (daily)")
    k10 = ecos("721Y001", "M", "200601", ym, "5050000")
    k10_w = to_weekly_last(k10, W, 70)
    lane("kr10", "Korea 10-year yield (KTB)", "%", k10_w, "ECOS 721Y001 5050000 (monthly average)")
    cpi = ecos("901Y009", "M", "200501", ym, "0")
    lane("krcpi", "Korea inflation (CPI, y/y)", "%", to_weekly_last((cpi / cpi.shift(12) - 1) * 100, W, 70), "ECOS 901Y009 (monthly)")

    # ---- co-movement: KOSPI, a KTB ETF (bond prices), won, gold, S&P 500, bitcoin
    import yfinance as yf
    try:
        ktb = to_weekly_last(yf.download("114260.KS", start="2009-01-01", progress=False, auto_adjust=True)["Close"].squeeze(), W, 10)
    except Exception as e:
        ktb = pd.Series(np.nan, index=W)
        log(f"  KTB ETF failed: {e}")
    LP = {"stocks": px["kospi"], "bonds": ktb, "usd": px["usdkrw"], "gold": px["gold"], "spx": px["spx"], "btc": px["btc"]}
    keys = list(LP)
    for i in range(len(keys)):
        for j in range(i + 1, len(keys)):
            links.append({"a": keys[i], "b": keys[j], "c": [r1(x, 2) for x in rolling_corr(LP[keys[i]], LP[keys[j]]).values]})

    MOV = {"KOSPI": px["kospi"], "Won per dollar": px["usdkrw"], "US stocks": px["spx"], "Gold": px["gold"],
           "Oil": px["oil"], "Bitcoin": px["btc"]}
    events = make_events(MOV, {"ff": base_w, "y10": k10_w}, W)

    latest_q = trx("S14", "F02TZB", "C").index.max()
    vmax = max(max([x for x in p["v"] if x is not None] or [1]) for p in pools if p["kind"] == "pool")
    meta = {"built_at": int(time.time() * 1000), "from": int(W[0].timestamp() * 1000), "to": int(W[-1].timestamp() * 1000),
            "n": len(W), "unit": "KRW billions", "cur": "₩", "region": "kr", "rscale": round(14 / math.sqrt(vmax), 5),
            "z1_latest": str(latest_q.date()), "flows_name": "The Bank of Korea flow of funds",
            "rate_labels": {"ff": "BoK rate", "y10": "Korea 10y"},
            "rules": ["Flows are drawn only where a source measures them (BoK flow of funds, KRX investor net buying).",
                      "Pool sizes are official levels; weeks between releases and spliced older-basis values are marked estimate.",
                      "Co-movement links are 13-week correlations of weekly returns — they show moving together, not cause."]}
    data = {"meta": meta, "weeks": [int(w.timestamp() * 1000) for w in W], "pools": pools, "hubs": hubs, "flows": flows,
            "lanes": lanes, "links": links, "events": events}
    OUT_KR.write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    log(f"wrote {OUT_KR.relative_to(ROOT)} · {OUT_KR.stat().st_size / 1e6:.2f} MB · {len(pools)} pools · {len(flows)} flows · "
        f"{len(links)} links · {len(events)} events · {time.time() - t0:.0f}s")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())
