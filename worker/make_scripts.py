"""Write researched, fact-checked scripts for new video requests.

Picks up every jobs/<id>.json with status "requested", writes scripts/<id>.json,
and moves the job to "script_ready" (or "failed" with a plain-language reason).
"""
import datetime
import json
import os
import random
import sys
import time

from common import HOUSE_STYLE, ROOT, WorkerError, gemini_json, read_json, research, save, stale, sync, write_json

WORDS_PER_SECOND = 2.5  # about 150 words a minute, a relaxed narration pace
MAX_JOBS_PER_RUN = int(os.environ.get("MAX_JOBS_PER_RUN", "6"))

# Rotating story shapes keep videos from feeling mass-produced.
STRUCTURES = [
    "Cold open on the most dramatic moment, then rewind to how it began, then the turning point, then the aftermath and why it still matters.",
    "Pose a mystery question in the hook, follow the clues in order, reveal the answer, then show what it changed.",
    "Follow one person (real, documented) through the event as the viewer's guide, then zoom out to the bigger picture.",
    "Myth versus fact: state the popular version, then carefully show what the evidence actually says.",
    "Countdown of the key moments that led to the outcome, building tension toward the final one.",
    "Day-in-the-life immersion: put the viewer in the place and time with sensory detail, then explain the event through that lens.",
]

SYSTEM = f"""You are the head writer for an original animated-history storytelling YouTube channel.
Rules you always follow:
- Be factually careful. Use the reference material provided. Never invent quotes, numbers, names or dates.
  If something is uncertain or disputed among historians, say so in the narration ("historians still debate...").
- Hook: the first sentence must grab attention within 5 seconds, without clickbait or false promises.
- Clear storytelling with a beginning, middle and end, and real educational value (context, causes, consequences).
- Respectful to all cultures and people. No graphic violence; describe tragedy with care.
- End with a short, natural call to subscribe that fits the story (not pushy).
- Visual descriptions are for AI-illustrated scenes in this house style: {HOUSE_STYLE}.
  Describe setting, figures, mood and camera framing. Never depict a living real person's likeness. No text in images.
- Write in clear, simple English for a global audience.
Answer only with JSON in the exact shape requested."""


def target(job):
    secs = job["length"] * (60 if job.get("lengthUnit") == "minutes" else 1)
    words = int(secs * WORDS_PER_SECOND)
    scene_secs = 5 if job["format"] == "short" else 14
    return secs, words, max(5, round(secs / scene_secs))


def write_script(job, sources):
    secs, words, scenes = target(job)
    structure = random.choice(STRUCTURES)
    refs = "\n\n".join(f"### Source {i + 1}: {p['title']} ({p['url']})\n{p['text']}" for i, p in enumerate(sources)) \
        or "(No reference text was found. Stick to widely documented facts and flag anything you are not sure of.)"
    aspect = "vertical 9:16" if job["format"] == "short" else "wide 16:9"
    prompt = f"""Write a {'YouTube Short' if job['format'] == 'short' else 'long YouTube video'} script.

Topic: {job['topic']}
Theme or angle: {job.get('theme') or 'your choice'}
Tone: {job.get('tone')}
Target audience: {job.get('audience')}
Owner's extra notes: {job.get('notes') or 'none'}
Length: about {secs} seconds of narration, so {int(words * 0.9)} to {words} words in total. Never go over {words} words.
Number of scenes: about {scenes}. Frame each scene for {aspect}.
Story structure to use: {structure}

Reference material (facts must come from here or be widely documented):
{refs}

Return JSON:
{{
  "working_title": "honest, curiosity-driven title under 70 characters",
  "hook": "the opening line, spoken in the first 5 seconds",
  "scenes": [
    {{"narration": "what the narrator says in this scene",
      "visual": "detailed illustration prompt for this scene",
      "motion": "one gentle camera move: slow zoom in | slow zoom out | pan left | pan right | drift up | drift down",
      "on_screen_text": "optional 1 to 4 words to show, or empty"}}
  ],
  "call_to_action": "the closing subscribe line (also include it in the last scene's narration)",
  "why_it_matters": "one sentence on the value this video gives viewers",
  "uses_realistic_altered_content": false
}}
Set "uses_realistic_altered_content" to true only if a scene would show a realistic-looking real person or
realistic depiction of a real event that viewers could mistake for real footage."""
    script = gemini_json(prompt, SYSTEM, temperature=0.85)
    if not isinstance(script, dict) or not script.get("scenes"):
        raise WorkerError("The AI returned an unusable script. It will try again within the hour.", transient=True)
    script["structure"] = structure
    count = sum(len(str(sc.get("narration", "")).split()) for sc in script["scenes"])
    if count > words * 1.15:  # too long for the slot: one trimming pass
        time.sleep(4)
        trimmed = gemini_json(
            f"""This narration has {count} words but must be at most {words} words. Shorten each scene's
"narration" so the total is between {int(words * 0.9)} and {words} words. Keep the hook, every fact, the story
order and the final subscribe line. Do not add new facts. Keep all other fields unchanged.
Return the same JSON shape.

{json.dumps(script, ensure_ascii=False)}""", SYSTEM, temperature=0.3)
        if isinstance(trimmed, dict) and trimmed.get("scenes"):
            trimmed["structure"] = structure
            script = trimmed
    elif count < words * 0.85:  # too short for the chosen length: one expanding pass
        time.sleep(4)
        longer = gemini_json(
            f"""This narration has {count} words but must be between {int(words * 0.9)} and {words} words.
Expand it by adding more scenes and richer storytelling: context, causes, vivid but accurate detail, and consequences.
Use ONLY facts from the reference material below or very widely documented history. Never invent quotes, numbers or names.
Keep the hook as the first line and the subscribe line at the end. Return the same JSON shape, with every scene
having narration, visual and motion.

Reference material:
{refs}

Script:
{json.dumps(script, ensure_ascii=False)}""", SYSTEM, temperature=0.6)
        if isinstance(longer, dict) and len(longer.get("scenes", [])) >= len(script["scenes"]):
            longer["structure"] = structure
            script = longer
    return script


def fact_check(job, script, sources):
    narration = "\n".join(f"[{i + 1}] {s.get('narration', '')}" for i, s in enumerate(script["scenes"]))
    refs = "\n\n".join(f"### {p['title']} ({p['url']})\n{p['text']}" for p in sources) or "(none)"
    prompt = f"""You are a strict history fact-checker. Check every factual claim in this narration
(names, dates, numbers, places, causes, quotes) against the reference material and well-established history.

Narration (scene numbers in brackets):
{narration}

Reference material:
{refs}

Return JSON:
{{
  "claims": [
    {{"scene": 1, "claim": "the claim, short", "verdict": "supported | uncertain | wrong",
      "source": "which source supports it, or 'general knowledge'", "note": "for uncertain or wrong: what is true or what to change"}}
  ],
  "summary": "one plain-English sentence for the channel owner"
}}
Use "uncertain" when the sources do not clearly back the claim or historians disagree."""
    result = gemini_json(prompt, "You check facts carefully and answer only with JSON.", temperature=0.1)
    claims = result.get("claims", []) if isinstance(result, dict) else []
    for c in claims:
        c["verdict"] = str(c.get("verdict", "uncertain")).lower()
        if c["verdict"] not in ("supported", "uncertain", "wrong"):
            c["verdict"] = "uncertain"
    return {"claims": claims, "summary": result.get("summary", "") if isinstance(result, dict) else ""}


def process(job_path):
    sync()
    job = read_json(job_path)
    if job and job.get("status") == "scripting" and stale(job, 90):
        job["status"] = "requested"
    if not job or job.get("status") != "requested":
        return False
    print(f"Writing script for {job['id']}: {job['topic']}")
    job["status"] = "scripting"  # claim it, so no other run writes it too
    job["updated"] = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    write_json(job_path, job)
    save(["jobs"], f"Writing script: {job['topic'][:60]}")
    try:
        sources = research(job["topic"], job.get("theme", ""))
        script = write_script(job, sources)
        time.sleep(4)  # stay well inside the free per-minute limit
        check = fact_check(job, script, sources)
        flagged = [c for c in check["claims"] if c["verdict"] != "supported"]
        words = sum(len(s.get("narration", "").split()) for s in script["scenes"])
        write_json(ROOT / "scripts" / f"{job['id']}.json", {
            "job_id": job["id"],
            "created": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
            "format": job["format"],
            **script,
            "word_count": words,
            "estimated_seconds": round(words / 2.5),
            "fact_check": check,
            "sources": [{"title": p["title"], "url": p["url"]} for p in sources],
        })
        job["status"] = "script_ready"
        job["flags"] = len(flagged)
        job.pop("error", None)
        job.pop("attempts", None)
    except Exception as e:  # keep the job visible instead of crashing the run
        print(repr(e), file=sys.stderr)
        job["attempts"] = job.get("attempts", 0) + 1
        transient = getattr(e, "transient", not isinstance(e, WorkerError))
        msg = str(e) if isinstance(e, WorkerError) else f"Something went wrong writing the script ({type(e).__name__})."
        if transient and job["attempts"] < 3:
            job["error"] = msg  # stays "requested", so the next run tries again
        else:
            job["status"] = "failed"
            job["error"] = msg + " Tap Try again in the Queue."
    if job["status"] == "scripting":
        job["status"] = "requested"  # temporary problem: back in line for the next run
    job["updated"] = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    write_json(job_path, job)
    save(["jobs", "scripts"], f"Script {'ready' if job['status'] == 'script_ready' else 'update'}: {job['topic'][:60]}")
    return True


def main():
    jobs = sorted((ROOT / "jobs").glob("*.json"))
    done = 0
    for path in jobs:
        if done >= MAX_JOBS_PER_RUN:
            break
        if process(path):
            done += 1
            time.sleep(4)
    print(f"Processed {done} job(s).")


if __name__ == "__main__":
    main()
