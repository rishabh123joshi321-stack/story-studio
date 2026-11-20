"""Suggest ranked topic ideas: trending, upcoming anniversaries, and evergreen.

Signals come from free Wikipedia data (what millions of people read yesterday,
and what happened on the coming dates). Gemini turns them into story ideas
and ranks them. Output: ideas/latest.json, read by the app's Ideas tab.
"""
import datetime
import sys

from common import ROOT, WorkerError, gemini_json, http_json, read_json, write_json

FEED = "https://en.wikipedia.org/api/rest_v1/feed"
SKIP = ("Main_Page", "Special:", "Wikipedia:", "Portal:", "File:", "Help:", "Template:")


def trending(day):
    try:
        data = http_json(f"{FEED}/featured/{day:%Y/%m/%d}")
    except Exception:
        return []
    out = []
    for a in data.get("mostread", {}).get("articles", []):
        if a.get("title", "").startswith(SKIP):
            continue
        out.append({"title": a.get("normalizedtitle") or a.get("title"), "views": a.get("views", 0),
                    "about": (a.get("description") or "")[:120]})
    return out[:40]


def anniversaries(start, days=10):
    out = []
    for i in range(days):
        d = start + datetime.timedelta(days=i)
        try:
            data = http_json(f"{FEED}/onthisday/selected/{d:%m/%d}")
        except Exception:
            continue
        for e in data.get("selected", [])[:8]:
            out.append({"date": f"{d:%b} {d.day}", "year": e.get("year"), "event": e.get("text", "")[:200]})
    return out


def needed(now, req):
    """Make ideas when asked from the app, when none exist, or once a day."""
    latest = read_json(ROOT / "ideas" / "latest.json")
    if not latest:
        return True
    made = datetime.datetime.fromisoformat(latest["created"])
    asked = req.get("requested")
    if asked and datetime.datetime.fromisoformat(asked.replace("Z", "+00:00")) > made:
        return True
    return now - made > datetime.timedelta(hours=23)


def main():
    now = datetime.datetime.now(datetime.timezone.utc)
    req = read_json(ROOT / "requests" / "ideas.json", {}) or {}
    if "--if-needed" in sys.argv and not needed(now, req):
        print("Ideas are fresh; nothing to do.")
        return
    focus = (req.get("focus") or "").strip()
    used = []
    for p in sorted((ROOT / "jobs").glob("*.json"))[-60:]:
        j = read_json(p, {})
        if j.get("topic"):
            used.append(j["topic"])

    hot = trending((now - datetime.timedelta(days=1)).date())
    upcoming = anniversaries(now.date())
    hot_txt = "\n".join(f"- {a['title']} ({a['views']:,} reads yesterday) {a['about']}" for a in hot) or "(unavailable today)"
    ann_txt = "\n".join(f"- {a['date']}, {a['year']}: {a['event']}" for a in upcoming) or "(unavailable today)"

    prompt = f"""You plan topics for an original animated-history storytelling YouTube channel with a global,
English-speaking audience. Any subject is welcome (history, science, culture, places, inventions, people),
told as a true story with real educational value.

{('The owner wants ideas about: ' + focus) if focus else 'No specific focus today: give a broad mix.'}

What people read most on Wikipedia yesterday:
{hot_txt}

Notable anniversaries in the next 10 days:
{ann_txt}

Topics already made or planned (do not repeat these):
{chr(10).join('- ' + t for t in used) or '(none yet)'}

Give 15 ideas: about 5 "trending" (a true story behind or connected to something people are reading now),
about 5 "anniversary" (publish close to the date), and about 5 "evergreen" (always searched).
Never exploit a current tragedy, a living private person, or breaking news; for trending items find the
historical story behind the interest. No clickbait. Rank by how likely a global audience is to click and keep watching.

Return JSON:
{{"ideas": [
  {{"topic": "short topic to type into the form",
    "title": "honest, curiosity-driven video title under 70 characters",
    "angle": "the story angle in one sentence",
    "kind": "trending | anniversary | evergreen",
    "format": "short | long",
    "score": 0-100,
    "signal": "the evidence, e.g. '412,000 Wikipedia reads yesterday' or 'Anniversary on Nov 24' or 'Searched every year'",
    "publish_by": "date to publish by for anniversaries, else empty"}}
]}}"""
    data = gemini_json(prompt, "You are a careful, creative content strategist. Answer only with JSON.", temperature=0.9)
    ideas = data.get("ideas", []) if isinstance(data, dict) else []
    if not ideas:
        raise WorkerError("No ideas came back from the AI.", transient=True)
    for i in ideas:
        try:
            i["score"] = max(0, min(100, int(i.get("score", 0))))
        except (TypeError, ValueError):
            i["score"] = 0
    ideas.sort(key=lambda i: i["score"], reverse=True)
    write_json(ROOT / "ideas" / "latest.json", {
        "created": now.isoformat(timespec="seconds"),
        "focus": focus,
        "ideas": ideas,
        "signals": {"trending_count": len(hot), "anniversary_count": len(upcoming)},
    })
    print(f"Saved {len(ideas)} ideas.")


if __name__ == "__main__":
    main()
