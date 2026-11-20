"""Collect channel stats for the Dashboard (Stage 7).

Once a day (and on demand) this reads, for the owner's own channel only:
  - YouTube Data API (youtube.readonly): subscribers, total views, recent videos with views/likes/comments.
  - YouTube Analytics API (yt-analytics.readonly, optional): daily views, watch time, subscribers gained,
    and the numbers the YouTube Partner Program looks at.
It writes stats/latest.json for the app, and adds one line per day to stats/history.json.
Standard library only.
"""
import datetime
import json
import urllib.error
import urllib.parse

from common import ROOT, WorkerError, read_json, save, sync, write_json
from upload import _api, access_token, log

DATA = "https://www.googleapis.com/youtube/v3/"
ANALYTICS = "https://youtubeanalytics.googleapis.com/v2/reports"


def get(url, token, **params):
    with _api(url + "?" + urllib.parse.urlencode(params), token, timeout=60) as r:
        return json.loads(r.read())


def report(token, start, end, metrics, dimensions=None, **extra):
    params = dict(ids="channel==MINE", startDate=start.isoformat(), endDate=end.isoformat(), metrics=metrics, **extra)
    if dimensions:
        params["dimensions"] = dimensions
    data = get(ANALYTICS, token, **params)
    cols = [c["name"] for c in data.get("columnHeaders", [])]
    return [dict(zip(cols, row)) for row in data.get("rows", []) or []]


def seconds(iso):
    """ISO 8601 duration like PT1M5S -> 65."""
    total, num = 0, ""
    for ch in iso.replace("PT", "").replace("P", ""):
        if ch.isdigit():
            num += ch
        else:
            total += int(num or 0) * {"H": 3600, "M": 60, "S": 1, "D": 86400}.get(ch, 0)
            num = ""
    return total


def channel_and_videos(token):
    ch = get(DATA + "channels", token, part="snippet,statistics,contentDetails", mine="true")["items"][0]
    st = ch["statistics"]
    out = {
        "title": ch["snippet"]["title"],
        "subscribers": int(st.get("subscriberCount", 0)),
        "subscribers_hidden": st.get("hiddenSubscriberCount", False),
        "views": int(st.get("viewCount", 0)),
        "videos": int(st.get("videoCount", 0)),
    }
    uploads = ch["contentDetails"]["relatedPlaylists"]["uploads"]
    items = get(DATA + "playlistItems", token, part="contentDetails", playlistId=uploads, maxResults=50).get("items", [])
    ids = [i["contentDetails"]["videoId"] for i in items]
    videos = []
    if ids:
        for v in get(DATA + "videos", token, part="snippet,statistics,contentDetails,status", id=",".join(ids)).get("items", []):
            s = v.get("statistics", {})
            dur = seconds(v["contentDetails"].get("duration", "PT0S"))
            videos.append({
                "id": v["id"], "title": v["snippet"]["title"], "published": v["snippet"]["publishedAt"],
                "privacy": v["status"]["privacyStatus"], "seconds": dur, "short": dur <= 180,
                "views": int(s.get("viewCount", 0)), "likes": int(s.get("likeCount", 0)), "comments": int(s.get("commentCount", 0)),
                "thumb": v["snippet"].get("thumbnails", {}).get("medium", {}).get("url", ""),
            })
    videos.sort(key=lambda v: v["published"], reverse=True)
    return out, videos


def analytics(token):
    today = datetime.date.today()
    end = today - datetime.timedelta(days=1)
    out = {}
    days = report(token, today - datetime.timedelta(days=28), end,
                  "views,estimatedMinutesWatched,subscribersGained,subscribersLost", "day", sort="day")
    out["daily"] = [{"day": d["day"], "views": int(d["views"]), "minutes": int(d["estimatedMinutesWatched"]),
                     "subs": int(d["subscribersGained"]) - int(d["subscribersLost"])} for d in days]
    last28 = report(token, today - datetime.timedelta(days=28), end, "views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost")
    if last28:
        r = last28[0]
        out["last28"] = {"views": int(r["views"]), "hours": round(int(r["estimatedMinutesWatched"]) / 60, 1),
                         "avg_view_seconds": int(r["averageViewDuration"]),
                         "subs": int(r["subscribersGained"]) - int(r["subscribersLost"])}
    # Partner Program: public long-video watch hours in the last 365 days, and Shorts views in the last 90.
    ypp = {}
    try:
        by_type = report(token, today - datetime.timedelta(days=365), end, "views,estimatedMinutesWatched", "creatorContentType")
        long_min = sum(int(r["estimatedMinutesWatched"]) for r in by_type if r["creatorContentType"] != "SHORTS")
        ypp["long_watch_hours_365"] = round(long_min / 60, 1)
        shorts90 = report(token, today - datetime.timedelta(days=90), end, "views", "creatorContentType")
        ypp["shorts_views_90"] = sum(int(r["views"]) for r in shorts90 if r["creatorContentType"] == "SHORTS")
        ypp["exact"] = True
    except urllib.error.HTTPError as e:
        log("Content-type split not available:", e.code, e.read().decode("utf-8", "replace")[:200])
        tot = report(token, today - datetime.timedelta(days=365), end, "estimatedMinutesWatched")
        ypp["long_watch_hours_365"] = round(int(tot[0]["estimatedMinutesWatched"]) / 60, 1) if tot else 0
        ypp["exact"] = False
    out["ypp"] = ypp
    try:
        rows = report(token, today - datetime.timedelta(days=365), end, "views,averageViewPercentage", "video", sort="-views", maxResults=50)
        out["per_video"] = {r["video"]: {"views": int(r["views"]), "averageViewPercentage": round(float(r["averageViewPercentage"]), 1)} for r in rows}
    except urllib.error.HTTPError as e:
        log("Per-video numbers not available:", e.code)
    return out


def main():
    sync()
    try:
        token = access_token()
    except WorkerError as e:
        log(e)
        return
    if not token:
        log("YouTube is not connected yet.")
        return
    now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    stats = {"updated": now}
    try:
        stats["channel"], stats["recent"] = channel_and_videos(token)
    except urllib.error.HTTPError as e:
        log("Channel read failed:", e.code, e.read().decode("utf-8", "replace")[:300])
        stats["error"] = "Could not read your channel. Open Settings > Connect YouTube and sign in again."
    try:
        stats.update(analytics(token))
        stats["analytics"] = True
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:300]
        log("Analytics not available:", e.code, detail)
        stats["analytics"] = False
        stats["analytics_note"] = ("Watch time is locked: turn on the YouTube Analytics API in Google Cloud and sign in again "
                                   "in Settings > Connect YouTube (see the steps in chat).")
    hist = read_json(ROOT / "stats" / "history.json", []) or []
    if "channel" in stats:
        day = now[:10]
        hist = [h for h in hist if h.get("day") != day]
        hist.append({"day": day, "subscribers": stats["channel"]["subscribers"], "views": stats["channel"]["views"],
                     "videos": stats["channel"]["videos"]})
        write_json(ROOT / "stats" / "history.json", hist[-400:])
    try:
        import insights
        jobs = {p.stem: read_json(p, {}) for p in (ROOT / "jobs").glob("*.json")}
        pkgs = {p.stem: read_json(p, {}) for p in (ROOT / "packages").glob("*.json")}
        hooks = {p.stem: (read_json(p, {}) or {}).get("hook_style") for p in (ROOT / "scripts").glob("*.json")}
        stats["insights"] = insights.build(stats, jobs, pkgs, stats.get("per_video", {}), hooks)
        insights.want_extra_clip(stats, jobs, pkgs)
        stats["report"] = insights.weekly(stats, hist, jobs)
    except Exception as e:  # insights are a bonus
        log("Insights skipped:", repr(e))
    write_json(ROOT / "stats" / "latest.json", stats)
    save(["stats", "jobs"], "Update channel stats")
    log("Stats saved.", json.dumps({k: stats.get(k) for k in ("channel", "last28", "ypp")})[:500])


if __name__ == "__main__":
    main()
