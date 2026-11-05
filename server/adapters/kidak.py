"""Kidak market adapter (slow / daily data): AI keyboards & writing/tone assistants.

Proxy signals only (no Instagram / X scraping). Every app entity is fed by up to four sources;
the UI shows per node how many actually deliver ("2/4 sources"), so thin data stays visible.

  appstore_lookup   iTunes Lookup API (kr storefront) — public, no key.        [primary]
                    value = average rating, energy = rating count,
                    delta = mean of the recent RSS reviews − lifetime ★ (sentiment drift)
  appstore_reviews  customer-review RSS, pages 1–10 (≤ 500 most recent reviews) — public, no key.
                    Every review is stored as a dated sample (value = ★) with backfill = true;
                    arrival times are Hawkes events ("review storm").
  naver_trend       Naver DataLab search trend, official API, needs NAVER_CLIENT_ID /
                    NAVER_CLIENT_SECRET in the environment (never hardcoded). Absent -> skipped,
                    the source shows "skipped" and nodes count it as missing. Daily series from
                    2016-01-01. Ratios are relative within one request, so every batch carries the
                    same anchor keyword group and is rescaled to anchor = 100 (index vs anchor).
  google_play       planned — no official public API for ratings/reviews; not fetched.

Cadence: daily. `run()` collects when the last successful collection is older than `refresh_s`
(survives restarts via the source log), otherwise sleeps until it is due. `run.py --collect kidak`
runs one pass and exits (for Windows Task Scheduler).
"""
from __future__ import annotations

import asyncio
import os
import time
from datetime import date, datetime, timedelta, timezone

import httpx

from ..model import Observation
from .base import Adapter

UA = {"User-Agent": "market-organism/0.1 (research prototype)"}
DAY = 86400


def _parse_ts(s: str) -> int:
    return int(datetime.fromisoformat(s).timestamp() * 1000)


class KidakAdapter(Adapter):
    mode = "daily"

    def sources(self):
        r = int(self.opts.get("refresh_s", DAY))
        st = int(r * 1.5)
        return [
            {"id": "appstore_lookup", "label": "App Store lookup (rating, count)", "cadence_s": r, "stale_after_s": st},
            {"id": "appstore_reviews", "label": "App Store review RSS (≤500 recent)", "cadence_s": r, "stale_after_s": st},
            {"id": "naver_trend", "label": "Naver DataLab search trend (env keys)", "cadence_s": r, "stale_after_s": st},
            {"id": "google_play", "label": "Google Play", "cadence_s": r, "planned": True,
             "note": "planned — no official public ratings/reviews API; not fetched"},
        ]

    # ------------------------------------------------------------------ scheduling
    async def run(self):
        eng = self.engine
        refresh = int(self.opts.get("refresh_s", DAY))
        while True:
            last = [eng.last_ok(s) for s in ("appstore_lookup", "appstore_reviews")]
            last = min((x for x in last if x), default=None)
            due = (last or 0) + refresh * 1000
            wait = (due - time.time() * 1000) / 1000
            if wait > 0:
                eng.set_status("schedule", "info",
                               f"daily source · last collection {datetime.fromtimestamp(last / 1000, tz=timezone.utc):%Y-%m-%d %H:%M} UTC"
                               f" · next in {wait / 3600:.1f} h (or run: python run.py --collect kidak)")
                await asyncio.sleep(min(wait, 3600))
                continue
            await self.cycle()

    async def cycle(self) -> dict:
        async with httpx.AsyncClient(timeout=25, headers=UA, follow_redirects=True) as cli:
            a = await self.appstore(cli)
            n = await self.naver(cli)
        self.engine.set_status("schedule", "ok", f"collected now · next in {int(self.opts.get('refresh_s', DAY)) / 3600:.0f} h")
        return {"appstore": a, "naver": n}

    # ------------------------------------------------------------------ App Store
    async def _reviews(self, cli, app_id, country, pages):
        out = []
        for p in range(1, pages + 1):
            rr = await cli.get(f"https://itunes.apple.com/{country}/rss/customerreviews/page={p}/id={app_id}/sortby=mostrecent/json")
            if rr.status_code != 200:
                break
            try:
                ents = rr.json().get("feed", {}).get("entry") or []
            except Exception:
                break
            if isinstance(ents, dict):
                ents = [ents]
            got = [(_parse_ts(x["updated"]["label"]), int(x["im:rating"]["label"]),
                    (x.get("im:version") or {}).get("label"))
                   for x in ents if isinstance(x, dict) and "im:rating" in x]
            if not got:
                break
            out += got
            await asyncio.sleep(0.25)
        return sorted(set(out))

    async def appstore(self, cli: httpx.AsyncClient) -> dict:
        eng = self.engine
        ents = [e for e in eng.entities if e.meta.get("app_id")]
        for e in eng.entities:
            if not e.meta.get("app_id"):
                why = e.meta.get("note") or "app_id not configured"
                eng.mark_missing(e.id, why, "appstore_lookup")
                eng.mark_missing(e.id, why, "appstore_reviews")
        pages = int(self.opts.get("rss_pages", 10))
        ok = nrev_total = nstored = 0
        for e in ents:
            app_id = e.meta["app_id"]
            country = e.meta.get("country", self.opts.get("country", "kr"))
            try:
                r = await cli.get("https://itunes.apple.com/lookup", params={"id": app_id, "country": country})
                r.raise_for_status()
                res = r.json().get("results", [])
                if not res:
                    eng.mark_missing(e.id, f"not found in {country} App Store (id {app_id})", "appstore_lookup")
                    eng.mark_missing(e.id, f"not found in {country} App Store (id {app_id})", "appstore_reviews")
                    continue
                a = res[0]
                avg = a.get("averageUserRating")
                cnt = a.get("userRatingCount")
                reviews = await self._reviews(cli, app_id, country, pages)
                now = int(time.time() * 1000)
                recent = reviews[-50:]
                recent_mean = sum(s for _, s, _ in recent) / len(recent) if recent else None
                span_days = (now - reviews[0][0]) / 86400000 if reviews else None
                last7 = sum(1 for t, _, _ in reviews if t >= now - 7 * 86400000)
                extra = {
                    "app": a.get("trackName"), "seller": a.get("sellerName"), "version": a.get("version"),
                    "last_release": (a.get("currentVersionReleaseDate") or "")[:10],
                    "price": a.get("formattedPrice"), "rating_count": cnt, "avg_rating": avg,
                    "rss_reviews": len(reviews), "rss_span_days": round(span_days, 1) if span_days else None,
                    "reviews_last_7d": last7 if reviews else None,
                    "recent50_mean": round(recent_mean, 2) if recent_mean else None,
                    "caveat": f"RSS returns at most the {pages * 50} most recent reviews; older history is not public",
                }
                store = eng.raw_store
                if store is not None:
                    today = datetime.now(timezone.utc).date()
                    prev = await asyncio.to_thread(store.previous_snapshot, eng.id, e.id, today)
                    await asyncio.to_thread(store.upsert_snapshot, eng.id, e.id, today, avg, cnt, extra)
                    if prev:
                        extra["prev_snapshot_day"] = str(prev[0])
                        extra["new_ratings_since_prev"] = (cnt - prev[2]) if (cnt is not None and prev[2] is not None) else None
                # every dated review -> history (value = ★); guard skips the ones already stored
                rev_obs = [Observation(entity=e.id, ts=t, value=float(s), source="appstore_reviews",
                                       extra={"version": v} if v else None) for t, s, v in reviews]
                nstored += await asyncio.to_thread(eng.persist_backfill, rev_obs)
                if reviews:
                    eng.ingest([Observation(entity=e.id, ts=reviews[-1][0], value=recent_mean, source="appstore_reviews",
                                            events=[(t, 1.0) for t, _, _ in reviews])], persist=False)
                else:
                    eng.mark_missing(e.id, "no reviews in RSS", "appstore_reviews")
                eng.ingest([Observation(
                    entity=e.id, ts=now, value=avg if avg else None, energy=float(cnt) if cnt else None,
                    delta=(recent_mean - avg) if (recent_mean is not None and avg) else None,
                    source="appstore_lookup", extra=extra)])
                ok += 1
                nrev_total += len(reviews)
            except Exception as ex:
                eng.mark_missing(e.id, f"App Store request failed: {ex!r}", "appstore_lookup")
            await asyncio.sleep(0.4)  # be polite
        msg = f"{ok}/{len(ents)} apps"
        if ok:
            eng.source_ok("appstore_lookup", ok, msg)
            eng.source_ok("appstore_reviews", nrev_total, f"{nrev_total} reviews in RSS, +{nstored} new stored")
        else:
            eng.source_fail("appstore_lookup", "error", "no app could be fetched")
            eng.source_fail("appstore_reviews", "error", "no app could be fetched")
        return {"apps": ok, "of": len(ents), "reviews": nrev_total, "new_reviews_stored": nstored}

    # ------------------------------------------------------------------ Naver DataLab
    async def naver(self, cli: httpx.AsyncClient) -> dict:
        eng = self.engine
        ents = [e for e in eng.entities if e.meta.get("keywords")]
        for e in eng.entities:
            if not e.meta.get("keywords"):
                eng.mark_missing(e.id, "no search keywords configured", "naver_trend")
        if not ents:
            return {"skipped": "no keywords"}
        cid, sec = os.environ.get("NAVER_CLIENT_ID"), os.environ.get("NAVER_CLIENT_SECRET")
        if not (cid and sec):
            for e in ents:
                eng.mark_missing(e.id, "Naver DataLab skipped: NAVER_CLIENT_ID / NAVER_CLIENT_SECRET not set", "naver_trend")
            eng.source_fail("naver_trend", "skip", "skipped — set NAVER_CLIENT_ID and NAVER_CLIENT_SECRET to enable")
            return {"skipped": "no env keys"}
        end = date.today() - timedelta(days=1)
        start = date.fromisoformat(self.opts.get("naver_start", "2016-01-01"))
        anchor = self.opts.get("naver_anchor", ["맞춤법 검사기"])
        # DataLab: 5 keyword groups per request; one slot is the shared anchor -> 4 entities per batch
        ok = n_pts = n_stored = 0
        for b in range(0, len(ents), 4):
            batch = ents[b:b + 4]
            groups = [{"groupName": "__anchor__", "keywords": anchor}] + \
                     [{"groupName": e.id, "keywords": e.meta["keywords"][:20]} for e in batch]
            body = {"startDate": start.isoformat(), "endDate": end.isoformat(), "timeUnit": "date", "keywordGroups": groups}
            try:
                r = await cli.post("https://openapi.naver.com/v1/datalab/search", json=body,
                                   headers={"X-Naver-Client-Id": cid, "X-Naver-Client-Secret": sec})
                if r.status_code != 200:
                    for e in batch:
                        eng.mark_missing(e.id, f"Naver DataLab HTTP {r.status_code}", "naver_trend")
                    eng.source_fail("naver_trend", "error", f"HTTP {r.status_code}: {r.text[:120]}")
                    continue
                res = {x["title"]: x.get("data", []) for x in r.json().get("results", [])}
                anc = [float(p["ratio"]) for p in res.get("__anchor__", [])]
                anc_mean = sum(anc) / len(anc) if anc else 0
                if not anc_mean:
                    for e in batch:
                        eng.mark_missing(e.id, "Naver DataLab: anchor keyword has no volume", "naver_trend")
                    continue
                for e in batch:
                    pts = [(int(datetime.fromisoformat(p["period"]).replace(tzinfo=timezone.utc).timestamp() * 1000),
                            float(p["ratio"]) / anc_mean * 100) for p in res.get(e.id, [])]
                    if not pts or not any(v > 0 for _, v in pts):
                        eng.mark_missing(e.id, "Naver DataLab: no search volume in range", "naver_trend")
                        continue
                    obs = [Observation(entity=e.id, ts=t, value=max(v, 1e-3), source="naver_trend") for t, v in pts]
                    n_stored += await asyncio.to_thread(eng.persist_backfill, obs)
                    vals = [v for _, v in pts]
                    m7, p7 = sum(vals[-7:]) / 7, (sum(vals[-14:-7]) / 7 if len(vals) >= 14 else None)
                    tail = obs[-(eng.p["corr_window"] + 2):]       # live state: only the correlation window
                    tail[-1].energy = m7
                    tail[-1].delta = (m7 / p7 - 1) if p7 else None
                    eng.ingest(tail, persist=False)
                    ok += 1
                    n_pts += len(pts)
            except Exception as ex:
                for e in batch:
                    eng.mark_missing(e.id, f"Naver DataLab failed: {ex!r}", "naver_trend")
        if ok:
            eng.source_ok("naver_trend", ok, f"{ok}/{len(ents)} keyword groups · {start}→{end} · index vs anchor “{anchor[0]}”=100")
        return {"groups": ok, "of": len(ents), "points": n_pts, "stored": n_stored}
