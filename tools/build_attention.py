"""Attention layer for the Money Map: what people searched, watched and read about, on the same weekly axis.

    python tools/build_attention.py        # needs web/money/data.json (+ data_kr.json) from build_money.py first
                                           # -> web/money/attention_us.json, attention_kr.json

Sources (public, no key):
  * Google Trends web search interest, 2004-, monthly (via pytrends; unofficial endpoint, so requests are paced and
    cached for 7 days under data/attention_cache). Values are *relative* (0-100), never counts. Keywords in different
    requests are put on one scale through a shared anchor keyword.
  * Google Trends YouTube search interest (gprop=youtube), 2008-, monthly, same scale rules.
  * Wikipedia pageviews (Wikimedia REST API), 2015-07-, monthly, real counts of article views.
  * GDELT DOC 2.0 news volume, 2017-, share of monitored world news mentioning the topic (US view only).
Not available historically, so not used: X / Instagram / TikTok mentions (paid or closed APIs; no scraping) and
YouTube view counts (the official API has no history).

Derived (data only):
  * lead/lag: correlation between a search *surge* (month vs its own 12-month average) and a money measure
    (monthly return, rate change or net buying) at -3..+3 months. Shown only with |r| >= 0.25 and >= 36 months.
  * spikes: for each "big move" week in the money data, the keyword whose search surge was most unusual that month.
"""
from __future__ import annotations

import hashlib
import json
import sys
import time
from pathlib import Path
from urllib.parse import quote

import httpx
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web" / "money"
CACHE = ROOT / "data" / "attention_cache"
UA = {"User-Agent": "market-organism-money-map/0.1 (+https://github.com/lollloolloll/3d_test)"}
http = httpx.Client(timeout=60, headers=UA, follow_redirects=True)
log = lambda *a: print(*a, flush=True)

# keyword -> money group (cash / bonds / real / stocks / crypto / macro). First keyword of the list is the anchor.
REGIONS = {
    "us": {
        "geo": "US", "wiki": "en.wikipedia",
        "web": [("inflation", "macro"), ("recession", "macro"), ("layoffs", "macro"), ("savings account", "cash"),
                ("treasury bonds", "bonds"), ("mortgage rates", "bonds"), ("housing market", "real"), ("gold price", "real"),
                ("stock market", "stocks"), ("buy stocks", "stocks"), ("bitcoin", "crypto"), ("crypto", "crypto")],
        "youtube": [("inflation", "macro"), ("recession", "macro"), ("stock market", "stocks"), ("bitcoin", "crypto"),
                    ("housing market", "real")],
        "wikiart": [("Inflation", "macro"), ("Recession", "macro"), ("Savings_account", "cash"),
                    ("United_States_Treasury_security", "bonds"), ("Real_estate", "real"), ("Gold_as_an_investment", "real"),
                    ("Stock_market", "stocks"), ("Bitcoin", "crypto")],
        "news": [("inflation", "macro"), ("recession", "macro"), ("stock market", "stocks"), ("housing market", "real"),
                 ("bitcoin", "crypto")],
        # (keyword, money series in data.json, how to read it)
        "pairs": [("bitcoin", "lane:btcp", "ret", "Bitcoin price"), ("stock market", "lane:spxp", "ret", "S&P 500"),
                  ("gold price", "lane:goldp", "ret", "Gold price"), ("inflation", "lane:cpi", "chg", "US inflation"),
                  ("recession", "lane:credit", "chg", "Credit stress"), ("mortgage rates", "lane:y10", "chg", "10-year yield"),
                  ("buy stocks", "flow:hh_eq", "flow", "Households → stocks")],
    },
    "kr": {
        "geo": "KR", "wiki": "ko.wikipedia",
        "web": [("주식", "stocks"), ("코스피", "stocks"), ("부동산", "real"), ("아파트", "real"), ("금값", "real"),
                ("예금", "cash"), ("적금", "cash"), ("금리", "bonds"), ("채권", "bonds"), ("비트코인", "crypto"),
                ("코인", "crypto"), ("물가", "macro"), ("환율", "macro"), ("경기침체", "macro")],
        "youtube": [("주식", "stocks"), ("부동산", "real"), ("비트코인", "crypto"), ("환율", "macro"), ("물가", "macro")],
        "wikiart": [("주식", "stocks"), ("부동산", "real"), ("예금", "cash"), ("채권", "bonds"), ("비트코인", "crypto"),
                    ("인플레이션", "macro"), ("환율", "macro")],
        "news": [],
        "pairs": [("비트코인", "lane:btcp", "ret", "Bitcoin price"), ("주식", "flow:ind_stk", "flow", "Individuals → stocks"),
                  ("코스피", "lane:kospi", "ret", "KOSPI"), ("환율", "lane:usdkrw", "ret", "USD/KRW"),
                  ("물가", "lane:krcpi", "chg", "Korea inflation"), ("금리", "lane:krrate", "chg", "BoK rate"),
                  ("부동산", "flow:hh_loan", "flow", "Loans → households")],
    },
}


# ------------------------------------------------------------------ cache
def cached(key: str, fn, days=7):
    CACHE.mkdir(parents=True, exist_ok=True)
    f = CACHE / (hashlib.sha1(key.encode()).hexdigest()[:16] + ".json")
    if f.exists() and time.time() - f.stat().st_mtime < days * 86400:
        return json.loads(f.read_text(encoding="utf-8"))
    v = fn()
    if v is not None:                                   # failures are retried next run, not cached
        f.write_text(json.dumps(v, ensure_ascii=False), encoding="utf-8")
    return v


# ------------------------------------------------------------------ Google Trends (web + YouTube)
_tr = None
def trends_batch(kws: list[str], geo: str, gprop: str) -> dict:
    """One Trends request (max 5 keywords) -> {kw: {YYYY-MM: value}}. Paced and retried; cached 7 days."""
    def fetch():
        global _tr
        from pytrends.request import TrendReq
        _tr = _tr or TrendReq(hl="en-US", tz=0)
        for attempt in range(5):
            try:
                _tr.build_payload(kws, timeframe="2004-01-01 " + time.strftime("%Y-%m-%d"), geo=geo, gprop=gprop)
                df = _tr.interest_over_time()
                time.sleep(6)
                return {k: {d.strftime("%Y-%m"): int(v) for d, v in df[k].items()} for k in kws if k in df}
            except Exception as e:
                wait = 30 * (attempt + 1)
                log(f"    trends {kws} {gprop or 'web'}: {type(e).__name__}, retry in {wait}s")
                time.sleep(wait)
        raise RuntimeError(f"Google Trends failed for {kws}")
    return cached(f"gt|{geo}|{gprop}|{'|'.join(kws)}|{time.strftime('%Y-%m')}", fetch)


def trends_scaled(kws: list[str], geo: str, gprop: str) -> dict[str, pd.Series]:
    """All keywords on one 0-100 scale: batches of 4 + the anchor (kws[0]), rescaled by the anchor, max = 100."""
    anchor, rest = kws[0], kws[1:]
    batches = [rest[i:i + 4] for i in range(0, len(rest), 4)] or [[]]
    out, base = {}, None
    for b in batches:
        r = trends_batch([anchor] + b, geo, gprop)
        s = {k: pd.Series(v, dtype=float) for k, v in r.items()}
        a = s[anchor]
        if base is None:
            base = a; f = 1.0
        else:
            both = (base > 0) & (a > 0)
            f = float(base[both].mean() / a[both].mean()) if both.sum() >= 12 else np.nan
        for k in [anchor] + b:
            if k in s and (k != anchor or anchor not in out):
                out[k] = s[k] * f
    m = max(float(v.max()) for v in out.values() if v.notna().any())
    return {k: (v / m * 100) for k, v in out.items()}


# ------------------------------------------------------------------ Wikipedia + GDELT
def wiki_monthly(project: str, article: str) -> pd.Series | None:
    def fetch():
        url = (f"https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/{project}/all-access/user/"
               f"{quote(article, safe='')}/monthly/20150701/{time.strftime('%Y%m')}0100")
        r = http.get(url)
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return {it["timestamp"][:4] + "-" + it["timestamp"][4:6]: it["views"] for it in r.json().get("items", [])}
    v = cached(f"wiki|{project}|{article}|{time.strftime('%Y-%m')}", fetch)
    return pd.Series(v, dtype=float) if v else None


_GDELT_DOWN = False


def gdelt_monthly(query: str) -> pd.Series | None:
    """News volume; if GDELT keeps refusing us, give up on news for this run (optional source)."""
    global _GDELT_DOWN

    def fetch():
        global _GDELT_DOWN
        if _GDELT_DOWN:
            return None
        for attempt in range(3):
            time.sleep(12 + 20 * attempt)                            # GDELT asks for at most one request per 5 s; be gentler
            r = http.get("https://api.gdeltproject.org/api/v2/doc/doc",
                         params={"query": f'"{query}"', "mode": "timelinevol", "format": "json",
                                 "startdatetime": "20170101000000", "enddatetime": time.strftime("%Y%m%d000000")})
            try:
                rows = r.json()["timeline"][0]["data"]
                s = pd.Series({x["date"][:8]: x["value"] for x in rows}, dtype=float)
                s.index = pd.to_datetime(s.index)
                mo = s.resample("MS").mean()
                return {d.strftime("%Y-%m"): round(float(v), 4) for d, v in mo.items() if np.isfinite(v)}
            except Exception:
                log(f"    gdelt '{query}': {r.text[:60]!r}, retry")
        _GDELT_DOWN = True
        log("    GDELT unavailable right now; news volume skipped this run")
        return None
    v = cached(f"gdelt|{query}|{time.strftime('%Y-%m')}", fetch)
    return pd.Series(v, dtype=float) if v else None


# ------------------------------------------------------------------ helpers
def to_weeks(monthly: pd.Series, weeks: pd.DatetimeIndex) -> list:
    """Each week shows its own month's value (a monthly measure, not an estimate); null where the month is missing."""
    m = monthly.dropna()
    return [None if (w.strftime("%Y-%m") not in m.index) else round(float(m[w.strftime("%Y-%m")]), 1) for w in weeks]


def surge(s: pd.Series) -> pd.Series:
    """Search surge: log of this month vs its own trailing 12-month average."""
    s = s.where(s > 0)
    return np.log(s / s.rolling(12, min_periods=12).mean().shift(1))


def money_monthly(D: dict, ref: str, kind: str) -> pd.Series | None:
    W = pd.to_datetime(D["weeks"], unit="ms")
    typ, rid = ref.split(":")
    src = next((x for x in D["lanes" if typ == "lane" else "flows"] if x["id"] == rid), None)
    if src is None:
        return None
    s = pd.Series(src["v" if typ == "lane" else "w"], index=W, dtype=float)
    if kind == "flow":
        m = s.resample("MS").sum(min_count=1)
    else:
        m = s.resample("MS").last()
        m = np.log(m).diff() if kind == "ret" else m.diff()
    m.index = m.index.strftime("%Y-%m")
    return m


def lead_lag(att: pd.Series, money: pd.Series) -> dict | None:
    x = surge(att)
    best = None
    for k in range(-3, 4):                       # k > 0: attention moves k months before money
        xs = x.copy(); xs.index = pd.PeriodIndex(xs.index, freq="M") + k
        xs.index = xs.index.strftime("%Y-%m")
        j = pd.concat([xs, money], axis=1, join="inner").dropna()
        if len(j) < 36:
            continue
        r = float(j.iloc[:, 0].corr(j.iloc[:, 1]))
        if best is None or abs(r) > abs(best["r"]):
            best = {"k": k, "r": round(r, 2), "n": len(j)}
    return best if best and abs(best["r"]) >= 0.25 else (best and {**best, "weak": True})


# ------------------------------------------------------------------ build
def build(region: str, cfg: dict) -> None:
    src = WEB / ("data.json" if region == "us" else "data_kr.json")
    if not src.exists():
        log(f"{region}: {src.name} missing, skipped (run build_money.py first)")
        return
    D = json.loads(src.read_text(encoding="utf-8"))
    weeks = pd.to_datetime(D["weeks"], unit="ms")
    series, raw = [], {}

    cur = time.strftime("%Y-%m")          # the running month is incomplete (e.g. 1 day of page views): leave it out

    def add(id, kw, group, srcname, s, unit, note):
        s = s[s.index < cur]
        series.append({"id": id, "kw": kw, "group": group, "src": srcname, "unit": unit, "note": note, "v": to_weeks(s, weeks)})

    log(f"{region}: Google Trends web …")
    for kw, s in trends_scaled([k for k, _ in cfg["web"]], cfg["geo"], "").items():
        g = dict(cfg["web"])[kw]
        raw[kw] = s[s.index < cur]
        add(f"web:{kw}", kw, g, "web", s, "0-100",
            f"Google web search interest, {cfg['geo']}, monthly; relative to the most-searched keyword here (=100)")
    log(f"{region}: Google Trends YouTube …")
    try:
        for kw, s in trends_scaled([k for k, _ in cfg["youtube"]], cfg["geo"], "youtube").items():
            add(f"yt:{kw}", kw, dict(cfg["youtube"])[kw], "youtube", s, "0-100",
                f"YouTube search interest (Google Trends), {cfg['geo']}, monthly, from 2008; relative scale")
    except Exception as e:
        log(f"  YouTube trends failed: {e}")
    log(f"{region}: Wikipedia pageviews …")
    for art, g in cfg["wikiart"]:
        try:
            s = wiki_monthly(cfg["wiki"], art)
        except Exception as e:
            s = None; log(f"  wiki {art}: {e}")
        if s is not None and len(s):
            add(f"wiki:{art}", art.replace("_", " "), g, "wiki", s, "views",
                f"{cfg['wiki']} article views per month (people, not bots), from 2015-07")
    if cfg["news"]:
        log(f"{region}: GDELT news volume …")
        for kw, g in cfg["news"]:
            s = gdelt_monthly(kw)
            if s is not None and len(s):
                add(f"news:{kw}", kw, g, "news", s, "% of news",
                    "GDELT: share of monitored world online news mentioning it, monthly average, from 2017")

    # lead / lag between search surges and money
    pairs = []
    for kw, ref, kind, label in cfg["pairs"]:
        if kw not in raw:
            continue
        m = money_monthly(D, ref, kind)
        if m is None or m.dropna().empty:
            continue
        ll = lead_lag(raw[kw], m)
        if ll:
            pairs.append({"kw": kw, "target": label, "kind": kind, **ll})

    # spikes at the money map's big-move weeks
    surges = pd.DataFrame({kw: surge(s) for kw, s in raw.items()})
    zs = (surges - surges.mean()) / surges.std()
    spikes = []
    for e in D["events"]:
        mo = pd.Timestamp(e["t"], unit="ms").strftime("%Y-%m")
        if mo in zs.index:
            row = zs.loc[mo].dropna()
            if len(row) and row.max() >= 1.5:
                kw = row.idxmax()
                spikes.append({"t": e["t"], "kw": kw, "x": round(float(np.exp(surges.loc[mo, kw])), 1), "z": round(float(row.max()), 1)})

    out = {"meta": {"built_at": int(time.time() * 1000), "region": region, "geo": cfg["geo"],
                    "rules": ["Search and YouTube values are Google Trends relative interest (0-100), not counts.",
                              "Wikipedia values are real monthly article views; news values are shares of world news.",
                              "Lead/lag is a correlation between search surges and money moves: together, not cause."]},
           "series": series, "pairs": pairs, "spikes": spikes}
    f = WEB / f"attention_{region}.json"
    f.write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    log(f"wrote {f.relative_to(ROOT)} · {f.stat().st_size / 1e3:.0f} kB · {len(series)} series · {len(pairs)} pairs · {len(spikes)} spikes")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    only = sys.argv[1:] or list(REGIONS)
    for rg in only:
        build(rg, REGIONS[rg])
