"""What's working, best time to post, and the weekly report card (features 5, 12, 19).

Pure arithmetic on numbers already collected by stats.py (no AI quota). Called from stats.py.
"""
import datetime
import statistics

IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
SLOTS = [(5, 11, "Morning (5-11 AM)"), (11, 16, "Afternoon (11 AM-4 PM)"), (16, 21, "Evening (4-9 PM)"), (21, 29, "Night (9 PM-5 AM)")]


def slot_of(hour):
    h = hour if hour >= 5 else hour + 24
    return next(name for a, b, name in SLOTS if a <= h < b)


def early_rate(v, now):
    """Views per day over the first week (a fair way to compare old and new videos)."""
    pub = datetime.datetime.fromisoformat(v["published"].replace("Z", "+00:00"))
    age = max(1.0, min(7.0, (now - pub).total_seconds() / 86400))
    return v["views"] / age


def mean_by(rows, key, val):
    groups = {}
    for r in rows:
        k = key(r)
        if k:
            groups.setdefault(k, []).append(val(r))
    return {k: (statistics.mean(v), len(v)) for k, v in groups.items()}


def build(stats, jobs, packages, per_video):
    now = datetime.datetime.now(datetime.timezone.utc)
    vids = [v for v in stats.get("recent", []) if v.get("privacy") == "public"]
    by_title = {str(p.get("title", "")).strip().lower(): jid for jid, p in packages.items()}
    by_yt = {j.get("youtube_id"): j for j in jobs.values() if j.get("youtube_id")}
    for v in vids:
        job = by_yt.get(v["id"]) or jobs.get(by_title.get(v["title"].strip().lower(), ""), {})
        v["tone"], v["theme"] = job.get("tone"), job.get("theme")
        pv = per_video.get(v["id"], {})
        v["avg_pct"] = pv.get("averageViewPercentage")
        v["rate"] = early_rate(v, now)
        v["slot"] = slot_of(datetime.datetime.fromisoformat(v["published"].replace("Z", "+00:00")).astimezone(IST).hour)
        v["weekday"] = datetime.datetime.fromisoformat(v["published"].replace("Z", "+00:00")).astimezone(IST).strftime("%A")
    out = {"tips": [], "top": [], "best_time": None}
    if not vids:
        out["tips"].append("Post a few public videos and tips will appear here after a few days.")
        return out
    out["top"] = [{"id": v["id"], "title": v["title"], "views": v["views"], "short": v["short"], "avg_pct": v.get("avg_pct")}
                  for v in sorted(vids, key=lambda v: v["views"], reverse=True)[:3]]
    shorts, longs = [v for v in vids if v["short"]], [v for v in vids if not v["short"]]
    if len(shorts) >= 2 and len(longs) >= 2:
        s, l = statistics.mean(v["rate"] for v in shorts), statistics.mean(v["rate"] for v in longs)
        better = "Shorts" if s > l else "long videos"
        out["tips"].append(f"Your {better} get about {max(s, l) / max(1, min(s, l)):.1f}x more views per day. Keep making them, "
                           f"and use them to point viewers to your {'long videos' if better == 'Shorts' else 'Shorts'}.")
    tones = {k: v for k, v in mean_by(vids, lambda r: r.get("tone"), lambda r: r["rate"]).items() if v[1] >= 2}
    if len(tones) >= 2:
        best = max(tones, key=lambda k: tones[k][0])
        out["tips"].append(f'Videos in the "{best}" tone do best so far. Try a preset with that tone for your next few videos.')
    pcts = [v["avg_pct"] for v in vids if v.get("avg_pct")]
    if len(pcts) >= 3:
        avg = statistics.mean(pcts)
        if avg < 35:
            out["tips"].append(f"Viewers watch about {avg:.0f}% of each video. Stronger openings help: use the Script score's opening idea.")
        elif avg > 60:
            out["tips"].append(f"Viewers watch {avg:.0f}% of your videos on average, which is excellent. Longer stories could work well.")
    slots = {k: v for k, v in mean_by(vids, lambda r: r["slot"], lambda r: r["rate"]).items() if v[1] >= 2}
    if len(slots) >= 2:
        best = max(slots, key=lambda k: slots[k][0])
        out["best_time"] = {"slot": best, "tested": {k: {"views_per_day": round(v[0], 1), "videos": v[1]} for k, v in slots.items()}}
        out["tips"].append(f"Videos posted in the {best.split(' (')[0].lower()} (India time) get the most early views so far.")
    else:
        tried = sorted({v["slot"] for v in vids})
        untried = [name for _, _, name in SLOTS if name not in tried]
        out["best_time"] = {"slot": None, "tested": {}, "try_next": untried[0] if untried else None}
        if untried:
            out["tips"].append(f"To find your best posting time, post the next 2 videos in the {untried[0].split(' (')[0].lower()} (India time).")
    if not out["tips"]:
        out["tips"].append("Keep posting: with a few more public videos the app can tell what works best.")
    return out


def weekly(stats, history, jobs):
    """The report card for the last 7 days."""
    today = datetime.datetime.now(IST).date()
    def at(days_ago):
        target = (today - datetime.timedelta(days=days_ago)).isoformat()
        rows = [h for h in history if h["day"] <= target]
        return rows[-1] if rows else None
    a, b, c = at(14), at(7), at(0)
    card = {"week_ending": today.isoformat(), "is_sunday": today.weekday() == 6}
    if b and c:
        card["views"] = c["views"] - b["views"]
        card["subs"] = c["subscribers"] - b["subscribers"]
        card["uploads"] = c["videos"] - b["videos"]
        if a:
            card["views_prev"] = b["views"] - a["views"]
    week_ago = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=7)).isoformat()
    recent = [v for v in stats.get("recent", []) if v["published"] >= week_ago[:19]]
    if recent:
        best = max(recent, key=lambda v: v["views"])
        card["best"] = {"id": best["id"], "title": best["title"], "views": best["views"]}
    nxt = (today + datetime.timedelta(days=7)).isoformat()
    card["planned_next_week"] = sum(1 for j in jobs.values() if j.get("plan_date") and today.isoformat() < j["plan_date"] <= nxt)
    grade_base = card.get("views_prev")
    if grade_base is not None and "views" in card:
        ratio = card["views"] / max(1, grade_base)
        card["grade"] = "A" if ratio >= 1.5 else "B" if ratio >= 1.05 else "C" if ratio >= 0.8 else "D"
    return card
