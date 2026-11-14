"""Mood layer for the Money Map: what people were into, beyond money, and where that shows up in money.

    python tools/build_mood.py [us|kr]   # after build_money.py and build_attention.py -> web/money/mood_{us,kr}.json

Five moods, each made of Google Trends *categories* (Google's own topic taxonomy, so nobody hand-picks keywords) plus,
for fear and greed, the search keywords already used by the attention layer:

    fear    jobs category + recession / layoffs / inflation (KR: 경기침체 / 환율 / 물가) searches
    greed   investing category + stock / coin searches
    play    comics & animation, anime & manga, games, movies, music, TV, concerts, travel, humor
    life    food & drink, restaurants, shopping, real estate, health
    future  education, programming, visa & immigration

Google Trends category values are relative (0-100 within one series) and Google's share of all searches changes over
20 years (in Korea it grew a lot against Naver). So a mood is measured against *its own recent past*:
    intensity = this month vs the same series' average of the previous 36 months (log ratio; shown as +x% / -x%).
The month's median intensity over all categories is subtracted (common drift: more people using Google at all),
so a mood rises only when attention shifts toward it. A mood is the average of its parts. It says "more / less than
usual", never "how many people".

"This month on Wikipedia" (2015-07-): the most-read articles that month (Wikimedia top list) after removing evergreen
pages (ones in the top list in more than a quarter of all months), each typed by Wikidata (TV series, video game,
internet meme, human -> occupation, ...) and put in a mood by that type. Unknown types stay "other".

Money side (data only, not causation): equal-weight price baskets from Yahoo monthly closes
    play   entertainment / content / games companies;  future  chips / tech;  life  retail (US)
and correlations between each mood's intensity and a money measure at -3..+3 months (|r| >= 0.25, >= 36 months).
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_attention as ba  # noqa: E402  (shared cache, pacing, Trends client, Wikipedia helpers)

ROOT, WEB, log, http, cached = ba.ROOT, ba.WEB, ba.log, ba.http, ba.cached
CUR = time.strftime("%Y-%m")

# Google Trends category ids (from pytrends.categories(), checked 2026-11)
CATS = {
    316: "Comics & animation", 317: "Anime & manga", 41: "Video games", 34: "Movies", 35: "Music", 36: "TV & video",
    891: "Concerts & festivals", 67: "Travel", 182: "Humor",
    71: "Food & drink", 276: "Restaurants", 18: "Shopping", 29: "Real estate", 45: "Health",
    74: "Education", 31: "Programming", 555: "Visa & immigration",
    60: "Jobs", 107: "Investing",
}
MOODS = [  # id, name, color, categories, keywords (from the attention layer's web list) per region
    ("fear", "Fear", "#ff6b6b", [60], {"us": ["recession", "layoffs", "inflation"], "kr": ["경기침체", "환율", "물가"]}),
    ("greed", "Greed", "#ffc94d", [107], {"us": ["stock market", "buy stocks", "bitcoin", "crypto"], "kr": ["주식", "코스피", "비트코인", "코인"]}),
    ("play", "Play", "#b98cff", [316, 317, 41, 34, 35, 36, 891, 67, 182], {}),
    ("life", "Daily life", "#5ee4a0", [71, 276, 18, 29, 45], {}),
    ("future", "Future", "#5ec8ff", [74, 31, 555], {}),
]
BASKETS = {
    "us": [("play", "Entertainment stocks", ["NFLX", "DIS", "NTDOY", "SONY", "TTWO"]),
           ("future", "Chip & tech stocks", ["SOXX", "QQQ"]),
           ("life", "Retail stocks", ["XRT", "WMT"])],
    "kr": [("play", "Entertainment stocks (KR)", ["035420.KS", "035720.KS", "036570.KS", "041510.KQ", "352820.KS", "259960.KS"]),
           ("future", "Chip stocks (KR)", ["005930.KS", "000660.KS"])],
}
# extra money measures for moods without a basket: (mood, ref in data json, kind, label)
PAIRS = {
    "us": [("fear", "lane:goldp", "ret", "Gold price"), ("fear", "lane:spxp", "ret", "S&P 500"), ("fear", "lane:credit", "chg", "Credit stress"),
           ("greed", "lane:btcp", "ret", "Bitcoin price"), ("greed", "flow:hh_eq", "flow", "Households → stocks"),
           ("life", "lane:retail", "chg", "US retail sales"), ("life", "lane:sent", "chg", "US consumer sentiment")],
    "kr": [("fear", "lane:usdkrw", "ret", "USD/KRW"), ("fear", "lane:kospi", "ret", "KOSPI"),
           ("greed", "flow:ind_stk", "flow", "Individuals → stocks"), ("greed", "lane:btcp", "ret", "Bitcoin price"),
           ("life", "lane:online", "chg", "Online shopping (y/y)"), ("life", "lane:ccsi", "chg", "Consumer sentiment")],
}


# ------------------------------------------------------------------ sources
def trends_category(cat: int, geo: str) -> pd.Series:
    def fetch():
        from pytrends.request import TrendReq
        ba._tr = ba._tr or TrendReq(hl="en-US", tz=0)
        for attempt in range(5):
            try:
                ba._tr.build_payload([""], cat=cat, timeframe="2004-01-01 " + time.strftime("%Y-%m-%d"), geo=geo)
                df = ba._tr.interest_over_time()
                time.sleep(6)
                col = [c for c in df.columns if c != "isPartial"][0]
                return {d.strftime("%Y-%m"): int(v) for d, v in df[col].items()}
            except Exception as e:
                wait = 30 * (attempt + 1)
                log(f"    trends cat {cat} {geo}: {type(e).__name__}, retry in {wait}s")
                time.sleep(wait)
        return None
    v = cached(f"gtcat|{geo}|{cat}|{CUR}", fetch)
    return pd.Series(v or {}, dtype=float)


def intensity(s: pd.Series) -> pd.Series:
    """log(month / mean of the previous 36 months); needs 24 months of history."""
    s = s[s.index < CUR].where(lambda x: x > 0)
    return np.log(s / s.rolling(36, min_periods=24).mean().shift(1))


def yahoo_monthly(tk: str) -> pd.Series:
    def fetch():
        import yfinance as yf
        h = yf.Ticker(tk).history(period="max", interval="1mo", auto_adjust=True)
        return {d.strftime("%Y-%m"): float(v) for d, v in h["Close"].items() if np.isfinite(v)} or None
    v = cached(f"yfm|{tk}|{CUR}", fetch, days=3)
    return pd.Series(v or {}, dtype=float)


def basket(tickers: list[str]) -> pd.Series:
    """Equal-weight monthly log-return average of whatever members exist that month; level = cumulative."""
    rets = pd.DataFrame({t: np.log(yahoo_monthly(t)).diff() for t in tickers})
    rets = rets[rets.index < CUR].sort_index()
    r = rets.mean(axis=1, skipna=True)
    return r


# ------------------------------------------------------------------ Wikipedia "this month"
EVERGREEN_SHARE = 0.25
TYPE_MOOD = [  # substring of a Wikidata class / occupation label -> mood
    ("internet meme", "play"), ("meme", "play"), ("television series", "play"), ("television program", "play"), ("drama", "play"),
    ("film", "play"), ("video game", "play"), ("anime", "play"), ("manga", "play"), ("webtoon", "play"), ("comic", "play"),
    ("album", "play"), ("song", "play"), ("single", "play"), ("musical group", "play"), ("band", "play"), ("girl group", "play"),
    ("boy band", "play"), ("idol", "play"), ("reality", "play"), ("animated", "play"), ("web series", "play"), ("youtube", "play"),
    ("character", "play"), ("concert", "play"), ("tour", "play"), ("sport", "play"), ("football", "play"), ("olympic", "play"),
    ("championship", "play"), ("cup", "play"), ("tournament", "play"), ("season", "play"), ("game show", "play"),
    ("actor", "play"), ("actress", "play"), ("singer", "play"), ("rapper", "play"), ("comedian", "play"), ("athlete", "play"),
    ("player", "play"), ("footballer", "play"), ("streamer", "play"), ("youtuber", "play"), ("television presenter", "play"),
    ("model", "play"), ("dancer", "play"), ("musician", "play"), ("film director", "play"),
    ("pandemic", "fear"), ("epidemic", "fear"), ("disease", "fear"), ("war", "fear"), ("earthquake", "fear"), ("disaster", "fear"),
    ("crisis", "fear"), ("recession", "fear"), ("shooting", "fear"), ("murder", "fear"), ("accident", "fear"), ("attack", "fear"),
    ("incident", "fear"), ("crash", "fear"), ("invasion", "fear"), ("bankruptcy", "fear"), ("virus", "fear"),
    ("cryptocurrency", "greed"), ("stock", "greed"), ("investor", "greed"), ("lottery", "greed"),
    ("artificial intelligence", "future"), ("language model", "future"), ("chatbot", "future"), ("software", "future"),
    ("programming", "future"), ("smartphone", "future"), ("spacecraft", "future"), ("technology", "future"),
    ("computer scientist", "future"), ("engineer", "future"),
    ("food", "life"), ("dish", "life"), ("holiday", "life"), ("festival", "life"), ("retail", "life"),
]
SKIP_TITLES = {"Main_Page", "대문", "-", "Undefined", "Cleopatra", "XXX"}


def wiki_top(project: str, y: int, m: int) -> list:
    def fetch():
        r = http.get(f"https://wikimedia.org/api/rest_v1/metrics/pageviews/top/{project}/all-access/{y}/{m:02d}/all-days")
        if r.status_code == 404:
            return None
        r.raise_for_status()
        arts = r.json()["items"][0]["articles"]
        return [[a["article"], a["views"]] for a in arts
                if ":" not in a["article"] and a["article"] not in SKIP_TITLES and "(동음이의)" not in a["article"]
                and "(disambiguation)" not in a["article"]][:80]
    return cached(f"wtop|{project}|{y}-{m:02d}", fetch, days=3650 if f"{y}-{m:02d}" < CUR else 1) or []


def wikidata_types(site: str, titles: list[str]) -> dict:
    """title -> [class/occupation labels], cached per title."""
    out, need = {}, []
    for t in titles:
        f = ba.CACHE / ("wd_" + __import__("hashlib").sha1(f"{site}|{t}".encode()).hexdigest()[:16] + ".json")
        if f.exists():
            out[t] = json.loads(f.read_text(encoding="utf-8"))
        else:
            need.append(t)
    for i in range(0, len(need), 50):
        chunk = need[i:i + 50]
        names = [t.replace("_", " ") for t in chunk]
        try:
            j = http.get("https://www.wikidata.org/w/api.php", params={
                "action": "wbgetentities", "sites": site, "titles": "|".join(names), "props": "claims|sitelinks",
                "sitefilter": site, "format": "json", "redirects": "yes"}).json()
        except Exception as e:
            log(f"    wikidata: {e}"); continue
        ids, ent = set(), {}
        for q, e in j.get("entities", {}).items():
            ti = e.get("sitelinks", {}).get(site, {}).get("title")
            if not ti:
                continue
            p31 = [c["mainsnak"].get("datavalue", {}).get("value", {}).get("id") for c in e.get("claims", {}).get("P31", [])]
            p106 = [c["mainsnak"].get("datavalue", {}).get("value", {}).get("id") for c in e.get("claims", {}).get("P106", [])][:3]
            ent[ti] = [x for x in p106 + p31 if x]
            ids.update(ent[ti])
        labels = {}
        ids = list(ids)
        for k in range(0, len(ids), 50):
            lj = http.get("https://www.wikidata.org/w/api.php", params={
                "action": "wbgetentities", "ids": "|".join(ids[k:k + 50]), "props": "labels", "languages": "en", "format": "json"}).json()
            labels.update({q: e.get("labels", {}).get("en", {}).get("value") for q, e in lj.get("entities", {}).items()})
        for t, nm in zip(chunk, names):
            v = [labels.get(x) for x in ent.get(nm, []) if labels.get(x)]
            out[t] = v
            f = ba.CACHE / ("wd_" + __import__("hashlib").sha1(f"{site}|{t}".encode()).hexdigest()[:16] + ".json")
            f.write_text(json.dumps(v, ensure_ascii=False), encoding="utf-8")
        time.sleep(0.5)
    return out


def type_mood(types: list[str]) -> tuple[str, str]:
    """(short type label, mood) from Wikidata labels; occupations come first for people."""
    if not types:
        return "", "other"
    low = [t.lower() for t in types]
    for sub, mood in TYPE_MOOD:
        for t, l in zip(types, low):
            if sub in l:
                return t, mood
    return types[0], "other"


def wiki_months(project: str, site: str) -> list:
    months = pd.period_range("2015-07", pd.Period(CUR, "M") - 1, freq="M")
    tops = {}
    for p in months:
        tops[str(p)] = wiki_top(project, p.year, p.month)
    n = len([v for v in tops.values() if v])
    seen = {}
    for v in tops.values():
        for t, _ in v[:60]:
            seen[t] = seen.get(t, 0) + 1
    ever = {t for t, c in seen.items() if c > EVERGREEN_SHARE * n}
    out = []
    for mo, v in tops.items():
        cand = [(t, views) for t, views in v[:60] if t not in ever][:8]
        if not cand:
            continue
        ty = wikidata_types(site, [t for t, _ in cand])
        items = []
        for t, views in cand:
            label, mood = type_mood(ty.get(t, []))
            items.append({"title": t.replace("_", " "), "type": label, "mood": mood, "views": views})
        out.append({"m": mo, "items": items[:5]})
    log(f"    wikipedia: {len(out)} months, {len(ever)} evergreen pages removed")
    return out


# ------------------------------------------------------------------ helpers
def corr_lag(x: pd.Series, money: pd.Series) -> dict | None:
    best = None
    for k in range(-3, 4):                    # k > 0: mood moves k months before money
        xs = x.copy(); xs.index = (pd.PeriodIndex(xs.index, freq="M") + k).strftime("%Y-%m")
        j = pd.concat([xs, money], axis=1, join="inner").dropna()
        if len(j) < 36:
            continue
        r = float(j.iloc[:, 0].corr(j.iloc[:, 1]))
        if best is None or abs(r) > abs(best["r"]):
            best = {"k": k, "r": round(r, 2), "n": len(j)}
    if not best:
        return None
    return best if abs(best["r"]) >= 0.25 else {**best, "weak": True}


def pct_weeks(x: pd.Series, weeks) -> list:
    """intensity (log) -> % vs usual, one value per week from its month."""
    return ba.to_weeks((np.exp(x) - 1) * 100, weeks)


# ------------------------------------------------------------------ build
def build(region: str) -> None:
    cfg = ba.REGIONS[region]
    src = WEB / ("data.json" if region == "us" else "data_kr.json")
    if not src.exists():
        log(f"{region}: {src.name} missing, skipped"); return
    D = json.loads(src.read_text(encoding="utf-8"))
    weeks = pd.to_datetime(D["weeks"], unit="ms")
    geo = cfg["geo"]

    log(f"{region}: Google Trends categories …")
    cats = {}
    for c in sorted({c for m in MOODS for c in m[3]}):
        s = trends_category(c, geo)
        if len(s):
            cats[c] = s
    kw = ba.trends_scaled([k for k, _ in cfg["web"]], geo, "")      # cached by the attention build
    # Common drift: when Google itself is used more (Korea 2010-13, the move to phones) every category rises together.
    # Remove the month's median intensity over all categories, so a mood only rises when attention shifts *toward* it.
    drift = pd.DataFrame({c: intensity(s) for c, s in cats.items()}).median(axis=1, skipna=True)
    rel = lambda s: (intensity(s) - drift.reindex(intensity(s).index)).dropna()

    moods = []
    for mid, name, color, mcats, mkw in MOODS:
        parts = []
        for c in mcats:
            if c in cats:
                parts.append((f"cat:{c}", CATS[c], "category", rel(cats[c])))
        for k in mkw.get(region, []):
            if k in kw:
                parts.append((f"kw:{k}", f"“{k}”", "search", rel(kw[k])))
        if not parts:
            continue
        X = pd.DataFrame({p[0]: p[3] for p in parts})
        x = X.mean(axis=1, skipna=True).where(X.notna().sum(axis=1) >= max(1, len(parts) // 2))
        moods.append({"id": mid, "name": name, "color": color, "_x": x,
                      "parts": [{"id": p[0], "label": p[1], "src": p[2], "v": pct_weeks(p[3], weeks)} for p in parts],
                      "v": pct_weeks(x, weeks)})

    log(f"{region}: price baskets …")
    baskets, pairs = [], []
    for mid, label, tks in BASKETS[region]:
        r = basket(tks)
        if r.dropna().empty:
            continue
        start = weeks[0].strftime("%Y-%m")
        lvl = np.exp(r[r.index >= start].fillna(0).cumsum()) * 100
        baskets.append({"id": f"bk_{mid}", "mood": mid, "label": label, "tickers": tks, "unit": "idx",
                        "src": "Yahoo Finance monthly closes, equal-weight; members join when listed", "v": ba.to_weeks(lvl.round(1), weeks)})
        m = next((mm for mm in moods if mm["id"] == mid), None)
        if m is not None:
            ll = corr_lag(m["_x"], r)
            if ll:
                pairs.append({"mood": mid, "target": label, "kind": "ret", **ll})
    for mid, ref, kind, label in PAIRS[region]:
        m = next((mm for mm in moods if mm["id"] == mid), None)
        mon = ba.money_monthly(D, ref, kind)
        if m is None or mon is None or mon.dropna().empty:
            continue
        ll = corr_lag(m["_x"], mon)
        if ll:
            pairs.append({"mood": mid, "target": label, "kind": kind, **ll})

    log(f"{region}: Wikipedia top articles …")
    site = "enwiki" if region == "us" else "kowiki"
    try:
        wiki = wiki_months(cfg["wiki"], site)
    except Exception as e:
        log(f"  wikipedia top failed: {e}"); wiki = []
    for w in wiki:
        w["t"] = int(pd.Timestamp(w["m"] + "-01").value // 10**6)

    for m in moods:
        m.pop("_x")
    out = {"meta": {"built_at": int(time.time() * 1000), "region": region, "geo": geo,
                    "rules": ["Mood = Google Trends category (and keyword) interest vs its own previous 36 months, minus the swing common to all categories that month; +x% means attention shifted toward it.",
                              "Trends values are relative, and Google's share of searches changes over time, so levels are never compared across years.",
                              "Wikipedia items are the most-read articles that month (evergreen pages removed), typed by Wikidata.",
                              "Mood ↔ money is a correlation at -3..+3 months: together, not cause."]},
           "moods": moods, "baskets": baskets, "pairs": pairs, "wiki": wiki}
    f = WEB / f"mood_{region}.json"
    f.write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    log(f"wrote {f.relative_to(ROOT)} · {f.stat().st_size / 1e3:.0f} kB · {len(moods)} moods · {len(baskets)} baskets · "
        f"{len(pairs)} pairs · {len(wiki)} wiki months")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    for rg in sys.argv[1:] or ["us", "kr"]:
        build(rg)
