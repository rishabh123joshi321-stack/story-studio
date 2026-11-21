"""Growth tactic 5: the weekly topic report.

Once a week (Sunday, India time), or when asked from the app, this reads which public
videos kept viewers watching longest (stats/latest.json, written by stats.py) and asks
Gemini for 5 new topics like the winners, plus one series idea. One AI request a week.
Output: ideas/weekly.json, shown on the Dashboard and the Ideas tab.
"""
import datetime
import sys

from common import ROOT, gemini_json, read_json, write_json

IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
OUT = ROOT / "ideas" / "weekly.json"


def needed(now, req):
    old = read_json(OUT)
    if not old:
        return True
    made = datetime.datetime.fromisoformat(old["created"])
    asked = req.get("requested")
    if asked and datetime.datetime.fromisoformat(asked.replace("Z", "+00:00")) > made:
        return True
    return now.astimezone(IST).weekday() == 6 and now - made > datetime.timedelta(days=5)


def rows(stats):
    per = stats.get("per_video", {}) or {}
    out = []
    for v in stats.get("recent", []):
        if v.get("privacy") != "public":
            continue
        pv = per.get(v["id"], {})
        out.append({"title": v["title"], "short": bool(v.get("short")), "views": v.get("views", 0),
                    "kept": pv.get("averageViewPercentage") or v.get("avg_pct"),
                    "minutes": pv.get("averageViewDuration")})
    return out


def main():
    now = datetime.datetime.now(datetime.timezone.utc)
    req = read_json(ROOT / "requests" / "topics.json", {}) or {}
    if "--if-needed" in sys.argv and not needed(now, req):
        print("Weekly topic report is fresh; nothing to do.")
        return
    stats = read_json(ROOT / "stats" / "latest.json", {}) or {}
    vids = rows(stats)
    used = [j.get("topic") for j in (read_json(p, {}) or {} for p in sorted((ROOT / "jobs").glob("*.json"))[-60:]) if j.get("topic")]
    series = sorted({j.get("series") for j in (read_json(p, {}) or {} for p in (ROOT / "jobs").glob("*.json")) if j.get("series")})
    if len(vids) < 2:
        write_json(OUT, {"created": now.isoformat(timespec="seconds"), "learning": True, "ideas": [], "series": None,
                         "summary": "Post at least 2 public videos. Next week the report will suggest topics like the ones that keep viewers watching."})
        print("Not enough public videos yet.")
        return
    ranked = sorted(vids, key=lambda r: ((r["kept"] or 0), r["views"]), reverse=True)
    table = "\n".join(f"- {r['title']} ({'Short' if r['short'] else 'long'}): {r['views']} views"
                      + (f", viewers watched {r['kept']:.0f}% on average" if r["kept"] else "") for r in ranked[:15])
    prompt = f"""You advise an animated-history storytelling YouTube channel (global, English-speaking audience).
Here are its public videos, best at keeping viewers first:
{table}

Topics already made or planned (do not repeat):
{chr(10).join('- ' + t for t in used) or '(none)'}

Existing series: {', '.join(series) or 'none'}

Work out what the best videos have in common (era, kind of story, angle, emotion) and suggest:
- 5 new video topics that share those strengths (true stories, real educational value, no clickbait),
- 1 series idea of 3 to 5 parts that people would binge, with part topics.
Return JSON:
{{"summary": "2 short sentences in plain English: what keeps your viewers watching",
  "ideas": [{{"topic": "short topic to type into the form", "title": "honest title under 70 characters",
             "angle": "one sentence", "format": "short | long", "why": "one sentence linking it to a winning video"}}],
  "series": {{"name": "series name under 40 characters", "why": "one sentence", "parts": ["part 1 topic", "part 2 topic", "part 3 topic"]}}}}"""
    data = gemini_json(prompt, "You are a careful YouTube strategist. Answer only with JSON.", temperature=0.8)
    if not isinstance(data, dict):
        data = {}
    ideas = [i for i in data.get("ideas", []) if isinstance(i, dict) and i.get("topic")][:5]
    for i in ideas:
        i["kind"] = "weekly"
    ser = data.get("series") if isinstance(data.get("series"), dict) and data["series"].get("name") else None
    write_json(OUT, {"created": now.isoformat(timespec="seconds"), "learning": False, "summary": str(data.get("summary", ""))[:400],
                     "ideas": ideas, "series": ser, "based_on": [r["title"] for r in ranked[:3]]})
    print(f"Saved weekly topic report with {len(ideas)} ideas.")


if __name__ == "__main__":
    main()
