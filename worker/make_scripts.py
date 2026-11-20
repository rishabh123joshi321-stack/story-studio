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

from common import ACTIONS, CAMERAS, EFFECTS, HOST, HOUSE_STYLE, ROOT, WorkerError, gemini_json, read_json, research, save, stale, sync, write_json

WORDS_PER_SECOND = 2.5  # about 150 words a minute, a relaxed narration pace
MAX_JOBS_PER_RUN = int(os.environ.get("MAX_JOBS_PER_RUN", "6"))
CHAPTER_MINUTES = 4  # long videos are written one chapter at a time
LIMITS = {  # how many pictures the free image service has to draw per video
    "short": {"places": 12, "cast": 4, "poses": 3},
    "long": {"places": 100, "cast": 14, "poses": 3},
}

# Rotating story shapes keep videos from feeling mass-produced.
STRUCTURES = [
    "Cold open on the most dramatic moment, then rewind to how it began, then the turning point, then the aftermath and why it still matters.",
    "Pose a mystery question in the hook, follow the clues in order, reveal the answer, then show what it changed.",
    "Follow one person (real, documented) through the event as the viewer's guide, then zoom out to the bigger picture.",
    "Myth versus fact: state the popular version, then carefully show what the evidence actually says.",
    "Countdown of the key moments that led to the outcome, building tension toward the final one.",
    "Day-in-the-life immersion: put the viewer in the place and time with sensory detail, then explain the event through that lens.",
]

SYSTEM = f"""You are the head writer and director of an original animated-history YouTube channel.
Rules you always follow:
- Be factually careful. Use the reference material provided. Never invent quotes, numbers, names or dates.
  If something is uncertain or disputed among historians, say so in the narration ("historians still debate...").
- Hook: the first sentence must grab attention within 5 seconds, without clickbait or false promises.
- Teach in every scene: who, what, when, where, why, and what it changed. Explain any unusual word in a few words.
  Clear storytelling with a beginning, middle and end.
- Voice: warm, chatty and curious, like a friend who loves history and explains it brilliantly. Vivid, simple
  explanations, comparisons to everyday life, and questions that make viewers want the answer. Humour is light
  and occasional (a playful aside now and then, never silly); the knowledge always comes first.
- Respectful to all cultures and people. No graphic violence or gore; describe tragedy with care.
- End with a short, natural call to subscribe that fits the story (not pushy).
- The video is a cut-out animated cartoon in a hand-painted storybook style ({HOUSE_STYLE}).
  Empty painted backgrounds ("places") have separately drawn characters and objects ("cast") moving on top.
  Every background must show exactly what the narration is talking about at that moment, and a background is
  never reused for a different moment. No "Did you know?" or fact pop-ups.
  You direct it shot by shot like a film: something moves, acts or changes in every shot, and the picture changes
  every 2 to 4 seconds. Vary places, cameras and actions so it never feels like a slideshow.
- Never depict a living real person. No text inside pictures.
- Write in clear, simple English for a global audience.
Answer only with JSON in the exact shape requested."""

SYSTEM_STILLS = SYSTEM.split("- The video is a cut-out")[0] + f"""- The video is made of rich, detailed painted pictures that look like still frames from a high-end animated
  feature film ({HOUSE_STYLE}). Each picture shows exactly what the narration says at that moment, with the people
  drawn inside the scene. No "Did you know?" or fact pop-ups.
- Never depict a living real person. No text inside pictures.
- Write in clear, simple English for a global audience.
Answer only with JSON in the exact shape requested."""

SHOT_RULES = """Each scene is one or two narration sentences with its own list of shots.
Give one shot for every 6 to 9 words of narration (each shot lasts about 3 seconds).
Shot fields:
- "kind": "story" (cast acting in a place), "guide" (the guide talks to the viewer on a plain paper background)
  or "title" (a big chapter title or question on screen; use for chapter starts and big questions only).
- "place": a place id from this part's "places" (story and title shots). The shots of one scene normally share
  that scene's place.
- "characters": 0 to 3 cast members, each {"id": cast id, "pose": one of its pose names,
  "then_pose": another pose name to switch to halfway, or "", "action": one action, "position": "left | center | right"}.
- "action" is one of: ACTIONS.
  People act: walk_in_left, walk_out_right, run_across, jump, celebrate, tremble, fall, strike, bow, nod, talk...
  Things move: fly_across (birds, arrows), drop_in, float, spin, sail_across (ships), appear, disappear.
- "camera": one of CAMERAS (push_in for drama, crash_zoom for shocks, pan for journeys, shake for chaos).
- "effect": one of EFFECTS that fits the moment (fire, smoke, rain, snow, dust, sparkles, explosion...), else "none".
- "time_label": e.g. "London, 1666" when the story jumps in time or place, else "".
- "bubble": rarely, a short speech bubble said by someone in the shot (max 6 words, never a made-up quote of a
  real person), else "".
- "note": guide shots only, a short handwritten note on screen (max 8 words), else "".
- "title": title shots only, max 6 words, else ""."""


def target(job):
    secs = job["length"] * (60 if job.get("lengthUnit") == "minutes" else 1)
    return secs, int(secs * WORDS_PER_SECOND)


def _refs(sources):
    return "\n\n".join(f"### Source {i + 1}: {p['title']} ({p['url']})\n{p['text']}" for i, p in enumerate(sources)) \
        or "(No reference text was found. Stick to widely documented facts and flag anything you are not sure of.)"


def plan_video(job, sources, structure):
    """Cast, places and chapter outline for the whole video."""
    secs, words = target(job)
    short = job["format"] == "short"
    lim = LIMITS["short" if short else "long"]
    chapters = 1 if short else max(2, round(secs / 60 / CHAPTER_MINUTES))
    guide_poses = ", ".join(HOST["poses"])
    prompt = f"""Plan a {'YouTube Short' if short else 'long YouTube video'} (about {secs} seconds, {words} words of narration).

Topic: {job['topic']}
Theme or angle: {job.get('theme') or 'your choice'}
Tone: {job.get('tone')}
Target audience: {job.get('audience')}
Owner's extra notes: {job.get('notes') or 'none'}
{('Changes the owner asked for after the previous version (follow these closely): ' + job['revision_notes'] + chr(10)) if job.get('revision_notes') else ''}Story structure to use: {structure}
Frame everything for a {'vertical 9:16' if short else 'wide 16:9'} screen.

Reference material (facts must come from here or be widely documented):
{_refs(sources)}

Return JSON:
{{
  "working_title": "honest, curiosity-driven title under 70 characters",
  "hook": "the opening line, spoken in the first 5 seconds",
  "cast": [
    {{"id": "short_snake_case_id", "kind": "person | animal | object",
      "look": "full visual description so the artist draws it the same every time: age, build, face, hair, clothes and colours (or shape, material and colours for objects); historically accurate",
      "poses": {{"pose_name": "body position and facial expression, e.g. 'standing, worried, hands clasped'"}}}}
  ],
  "chapters": [{{"title": "short chapter title", "covers": "what this part tells, in order, with the key facts"}}],
  "use_guide": false,
  "call_to_action": "the closing subscribe line",
  "why_it_matters": "one sentence on the value this video gives viewers",
  "uses_realistic_altered_content": false
}}
Rules: at most {lim['cast']} cast members with 2 to {lim['poses']} poses each (objects may have 1 pose, e.g. "default");
exactly {chapters} chapter{'s' if chapters > 1 else ''}.
Typical cast: the key real people (no living people), an everyday person of the time, and moving things that matter
to the story (a ship, a horse, a cart, a crown, a cannon, a scroll...).
The channel also has an optional guide, {HOST['name']}, a cheerful young time-traveller (poses: {guide_poses}).
Set "use_guide" to true only if she would really help explain this topic (tricky ideas, quick recaps, questions to
the viewer); do not add her to "cast".
Set "uses_realistic_altered_content" to true only if a shot would show a realistic-looking real person or a
realistic depiction of a real event that viewers could mistake for real footage."""
    plan = gemini_json(prompt, SYSTEM, temperature=0.8)
    if not isinstance(plan, dict) or not plan.get("chapters"):
        raise WorkerError("The AI returned an unusable plan. It will try again within the hour.", transient=True)
    plan["places"] = []  # each part creates its own backgrounds, matched to its narration
    return plan


def _cast_text(plan):
    lines = []
    for c in plan["cast"]:
        lines.append(f"- {c['id']} ({c.get('kind', 'person')}): poses {', '.join(c['poses'])}")
    if plan.get("use_guide"):
        lines.append(f"- guide ({HOST['name']}, guide shots only): poses {', '.join(HOST['poses'])}")
    return "\n".join(lines) or "(none)"


def write_chapter(job, plan, sources, index, words, previous):
    short = job["format"] == "short"
    total = len(plan["chapters"])
    ch = plan["chapters"][index]
    first, last = index == 0, index == total - 1
    rules = SHOT_RULES.replace("ACTIONS", ", ".join(ACTIONS)).replace("CAMERAS", ", ".join(CAMERAS)) \
        .replace("EFFECTS", ", ".join(EFFECTS))
    budget = LIMITS["short" if short else "long"]["places"] // total
    place_rule = (f"Give EVERY scene its own new place that shows what that scene's narration describes (up to {budget})."
                  if short else f"Give every scene, or at most every two scenes, its own new place that shows what the "
                  f"narration describes there (about {budget} places for this part).")
    guide = (f"Guide shots with {HOST['name']}: use only where they truly help (a tricky idea, a quick recap, a question "
             f"to the viewer), at most one shot in eight.") if plan.get("use_guide") else "Do not use guide shots."
    prompt = f"""Write {'the script' if short else f'chapter {index + 1} of {total}'} of a {'YouTube Short' if short else 'long YouTube video'} about "{job['topic']}".
{'' if short else f'Chapter title: {ch.get("title")}' + chr(10)}What it covers: {ch.get('covers')}
Length: {int(words * 0.9)} to {words} words of narration in total. Never go over {words} words.
{('Start with this hook as the first sentence: ' + plan.get('hook', '')) if first else 'Carry on smoothly from the previous part, which ended: ' + previous}
{('End with this subscribe line: ' + plan.get('call_to_action', '')) if last else 'End on a line that makes viewers want the next part (no subscribe line yet).'}
{'' if short else 'Start the chapter with a title shot showing the chapter title.'}
Tone: {job.get('tone')}. Audience: {job.get('audience')}.
{('Changes the owner asked for (follow closely): ' + job['revision_notes']) if job.get('revision_notes') else ''}

Cast (use these ids and pose names only):
{_cast_text(plan)}
Backgrounds ("places"): create them for this part. {place_rule}
Describe each as the empty setting only (no people or animals): where, era, time of day, weather, the key objects
the narration mentions, and the mood. Each must look clearly different from the others.

{rules}
{guide}

Reference material (facts must come from here or be widely documented):
{_refs(sources)}

Return JSON:
{{"places": [{{"id": "short_snake_case_id", "look": "..."}}],
 "scenes": [{{"narration": "what the narrator says", "shots": [{{"kind": "story", "place": "...", "characters": [{{"id": "...", "pose": "...", "then_pose": "", "action": "walk_in_left", "position": "left"}}], "camera": "push_in", "effect": "none", "time_label": "", "bubble": "", "note": "", "title": ""}}]}}]}}"""
    out = gemini_json(prompt, SYSTEM, temperature=0.8)
    scenes = out.get("scenes") if isinstance(out, dict) else out if isinstance(out, list) else None
    if scenes and isinstance(out, dict):  # this part's backgrounds get ids that cannot clash with other parts
        rename = {}
        for p in (out.get("places") or [])[:budget + 2]:
            pid = str(p.get("id", "")).strip().lower().replace(" ", "_")
            if pid and p.get("look"):
                rename[pid] = f"c{index}_{pid}"
                plan["places"].append({"id": rename[pid], "look": str(p["look"])})
        for sc in scenes:
            for sh in sc.get("shots") or []:
                key = str(sh.get("place", "")).strip().lower().replace(" ", "_")
                sh["place"] = rename.get(key, key)
    if not scenes:
        raise WorkerError("The AI returned an unusable script part. It will try again within the hour.", transient=True)
    count = sum(len(str(s.get("narration", "")).split()) for s in scenes)
    if count > words * 1.2 or count < words * 0.8:  # one correcting pass
        time.sleep(4)
        fix = gemini_json(
            f"""This script part has {count} words of narration but needs {int(words * 0.9)} to {words} words.
{'Shorten the narration, keeping every fact, the order and the opening and closing lines.' if count > words else
 'Add scenes with richer storytelling: context, causes, vivid but accurate detail and consequences, using ONLY facts from the reference material or very widely documented history.'}
Keep one shot per 6 to 9 words of narration, using the same fields and the same cast, pose and place ids
(place ids: {', '.join(p['id'] for p in plan['places'] if p['id'].startswith(f'c{index}_'))}).
Return the same JSON shape: {{"scenes": [...]}}.

Reference material:
{_refs(sources) if count < words else '(not needed)'}

Script part:
{json.dumps({'scenes': scenes}, ensure_ascii=False)}""", SYSTEM, temperature=0.5)
        fixed = fix.get("scenes") if isinstance(fix, dict) else None
        if fixed:
            scenes = fixed
    return direct_more(scenes, plan, rules, guide, index)


def direct_more(scenes, plan, rules, guide, index):
    """AI models tend to give one long shot per scene. Ask once more for real 2-4 second cuts."""
    words = sum(len(str(s.get("narration", "")).split()) for s in scenes)
    shots = sum(len(s.get("shots") or []) for s in scenes)
    need = max(len(scenes), round(words / 7.5))
    if shots >= need * 0.75:
        return scenes
    print(f"  only {shots} shots for {words} words; asking for about {need}", flush=True)
    time.sleep(4)
    out = gemini_json(f"""You are the film director. This script part has {shots} shots but needs about {need}
(one shot for every 6 to 9 words of narration, so the picture changes every 2 to 4 seconds, like a cartoon film).
Keep every "narration" exactly as it is. Rewrite each scene's "shots" list: split it into several shots that show
the story beat by beat. Change camera, action, characters or effect from one shot to the next, so something
new moves in every shot: objects that move, reaction shots, people arriving and leaving. Keep each scene's place.

Cast (ids and pose names):
{_cast_text(plan)}
Places (ids):
{chr(10).join('- ' + p['id'] + ': ' + p['look'][:90] for p in plan['places'] if p['id'].startswith(f'c{index}_'))}

{rules}
{guide}

Return the same JSON shape: {{"scenes": [...]}}.

{json.dumps({'scenes': scenes}, ensure_ascii=False)}""", SYSTEM, temperature=0.7)
    better = out.get("scenes") if isinstance(out, dict) else None
    if better and len(better) == len(scenes) and sum(len(s.get("shots") or []) for s in better) > shots:
        for old, new in zip(scenes, better):
            old["shots"] = new.get("shots") or old.get("shots")
    return scenes


def tidy(plan, scenes, short):
    """Make every shot use only known places, cast, poses, actions, cameras and effects."""
    lim = LIMITS["short" if short else "long"]
    cast = {}
    for c in plan.get("cast", [])[:lim["cast"]]:
        cid = str(c.get("id", "")).strip().lower().replace(" ", "_")
        poses = {str(k).strip().lower().replace(" ", "_"): str(v) for k, v in (c.get("poses") or {}).items()}
        if cid and cid not in ("guide", HOST["name"].lower()) and poses and c.get("look"):
            cast[cid] = {"id": cid, "kind": c.get("kind", "person"), "look": str(c["look"]),
                         "poses": dict(list(poses.items())[:lim["poses"]])}
    places = {}
    for p in plan.get("places", [])[:lim["places"]]:
        pid = str(p.get("id", "")).strip().lower().replace(" ", "_")
        if pid and p.get("look"):
            places[pid] = {"id": pid, "look": str(p["look"])}
    if not places:
        raise WorkerError("The AI plan had no usable places. It will try again within the hour.", transient=True)
    guide = bool(plan.get("use_guide"))
    place_ids = list(places)
    last_place = place_ids[0]
    clean = []
    for sc in scenes:
        narration = " ".join(str(sc.get("narration", "")).split())
        if not narration:
            continue
        shots = []
        for sh in (sc.get("shots") or [])[:8]:
            kind = str(sh.get("kind", "story")).lower()
            kind = kind if kind in ("story", "guide", "title") else "story"
            if kind == "guide" and not guide:
                kind = "story"
            place = str(sh.get("place", "")).strip().lower().replace(" ", "_")
            place = place if place in places else last_place
            last_place = place
            chars = []
            for c in (sh.get("characters") or [])[:3]:
                cid = str(c.get("id", "")).strip().lower().replace(" ", "_")
                cid = "guide" if cid == HOST["name"].lower() else cid
                pool = HOST["poses"] if cid == "guide" else cast.get(cid, {}).get("poses")
                if not pool or (cid == "guide" and not guide):
                    continue
                pose = str(c.get("pose", "")).strip().lower().replace(" ", "_")
                pose = pose if pose in pool else next(iter(pool))
                then = str(c.get("then_pose", "")).strip().lower().replace(" ", "_")
                action = str(c.get("action", "stand")).strip().lower().replace(" ", "_")
                pos = str(c.get("position", "center")).strip().lower()
                chars.append({"id": cid, "pose": pose, "then_pose": then if then in pool and then != pose else "",
                              "action": action if action in ACTIONS else "stand",
                              "position": pos if pos in ("left", "center", "right") else "center"})
            if kind == "guide":
                g = next((c for c in chars if c["id"] == "guide"), None)
                chars = [g or {"id": "guide", "pose": "talk", "then_pose": "", "action": "talk", "position": "center"}]
            else:
                chars = [c for c in chars if c["id"] != "guide"]
            camera = str(sh.get("camera", "static")).strip().lower()
            effect = str(sh.get("effect", "none")).strip().lower()
            shots.append({
                "kind": kind, "place": place, "characters": chars,
                "camera": camera if camera in CAMERAS else "static",
                "effect": effect if effect in EFFECTS else "none",
                "time_label": str(sh.get("time_label") or "")[:24],
                "fact": "",  # the owner finds fact pop-ups distracting
                "bubble": " ".join(str(sh.get("bubble") or "").split()[:7]),
                "note": " ".join(str(sh.get("note") or "").split()[:9]),
                "title": " ".join(str(sh.get("title") or "").split()[:7]) if kind == "title" else "",
            })
        if not shots:
            shots = [{"kind": "story", "place": last_place, "characters": [], "camera": "push_in", "effect": "none",
                      "time_label": "", "fact": "", "bubble": "", "note": "", "title": ""}]
        clean.append({"narration": narration, "chapter": sc.get("chapter", 0), "shots": shots})
    # keep only what is actually used, so no picture is drawn for nothing
    used_places = {sh["place"] for sc in clean for sh in sc["shots"] if sh["kind"] != "guide"}
    used = {}
    for sc in clean:
        for sh in sc["shots"]:
            for c in sh["characters"]:
                used.setdefault(c["id"], set()).update({c["pose"]} | ({c["then_pose"]} if c["then_pose"] else set()))
    cast_out = []
    for cid, c in cast.items():
        if cid in used:
            c["poses"] = {k: v for k, v in c["poses"].items() if k in used[cid]}
            cast_out.append(c)
    return clean, cast_out, [places[p] for p in place_ids if p in used_places], guide and "guide" in used


STILLS_RULES = """Each scene is narration plus ONE detailed picture that shows exactly what that narration describes.
Scene fields:
- "narration": what the narrator says (SCENE_LENGTH).
- "picture": a rich description of one cinematic illustration for this exact moment: the setting, the people in it
  (repeat each person's full look from the cast list every time, plus their expression and what they are doing),
  the objects the narration mentions, the time of day, the lighting and mood, and the framing (wide establishing shot,
  medium shot or dramatic close-up; vary them). Every picture must be different: never repeat a picture or setting
  for a different moment. No text or signs with words. Never a living person.
- "camera": one of push_in, pull_out, pan_left, pan_right, tilt_up (the slow camera move over the picture).
- "effect": a gentle moving effect if it fits the moment (fire, embers, smoke, rain, snow, dust, fog, leaves, birds,
  sparkles, lightning, water), else "none".
- "time_label": e.g. "London, 1666" when the story jumps in time or place, else ""."""


def write_chapter_stills(job, plan, sources, index, words, previous):
    """Rich still pictures: one detailed illustration per scene, characters drawn inside it."""
    short = job["format"] == "short"
    total = len(plan["chapters"])
    ch = plan["chapters"][index]
    first, last = index == 0, index == total - 1
    rules = STILLS_RULES.replace("SCENE_LENGTH", "one sentence, about 5 seconds" if short
                                 else "two or three sentences, about 15 seconds")
    cast = "\n".join(f"- {c.get('id')}: {c.get('look')}" for c in plan.get("cast", [])) or "(none)"
    prompt = f"""Write {'the script' if short else f'chapter {index + 1} of {total}'} of a {'YouTube Short' if short else 'long YouTube video'} about "{job['topic']}".
{'' if short else f'Chapter title: {ch.get("title")}' + chr(10)}What it covers: {ch.get('covers')}
Length: {int(words * 0.9)} to {words} words of narration in total. Never go over {words} words.
{('Start with this hook as the first sentence: ' + plan.get('hook', '')) if first else 'Carry on smoothly from the previous part, which ended: ' + previous}
{('End with this subscribe line: ' + plan.get('call_to_action', '')) if last else 'End on a line that makes viewers want the next part (no subscribe line yet).'}
Tone: {job.get('tone')}. Audience: {job.get('audience')}. Frame pictures for a {'vertical 9:16' if short else 'wide 16:9'} screen.
{('Changes the owner asked for (follow closely): ' + job['revision_notes']) if job.get('revision_notes') else ''}

People and things that appear (describe them exactly like this in every picture they are in):
{cast}

{rules}

Reference material (facts must come from here or be widely documented):
{_refs(sources)}

Return JSON:
{{"scenes": [{{"narration": "...", "picture": "...", "camera": "push_in", "effect": "none", "time_label": ""}}]}}"""
    out = gemini_json(prompt, SYSTEM_STILLS, temperature=0.8)
    scenes = out.get("scenes") if isinstance(out, dict) else out if isinstance(out, list) else None
    if not scenes:
        raise WorkerError("The AI returned an unusable script part. It will try again within the hour.", transient=True)
    count = sum(len(str(s.get("narration", "")).split()) for s in scenes)
    if count > words * 1.2 or count < words * 0.8:  # one correcting pass
        time.sleep(4)
        fix = gemini_json(
            f"""This script part has {count} words of narration but needs {int(words * 0.9)} to {words} words.
{'Shorten the narration, keeping every fact, the order and the opening and closing lines.' if count > words else
 'Add scenes with richer storytelling: context, causes, vivid but accurate detail and consequences, using ONLY facts from the reference material or very widely documented history.'}
Every scene keeps the same fields, with its own detailed "picture". Return the same JSON shape: {{"scenes": [...]}}.

Reference material:
{_refs(sources) if count < words else '(not needed)'}

Script part:
{json.dumps({'scenes': scenes}, ensure_ascii=False)}""", SYSTEM_STILLS, temperature=0.5)
        fixed = fix.get("scenes") if isinstance(fix, dict) else None
        if fixed:
            scenes = fixed
    return scenes


def stills_to_shots(parts, chapters, short):
    """Turn still-picture scenes into the video maker's format: each picture is its own place."""
    places, scenes = [], []
    for i, part in enumerate(parts):
        for n, sc in enumerate(part):
            narration = " ".join(str(sc.get("narration", "")).split())
            picture = " ".join(str(sc.get("picture", "")).split())
            if not narration:
                continue
            if picture:
                places.append({"id": f"c{i}_p{n}", "look": picture, "full": True})
            elif not places:
                continue
            camera = str(sc.get("camera", "push_in")).lower()
            effect = str(sc.get("effect", "none")).lower()
            shot = {"kind": "story", "place": places[-1]["id"], "characters": [],
                    "camera": camera if camera in CAMERAS else "push_in",
                    "effect": effect if effect in EFFECTS else "none",
                    "time_label": str(sc.get("time_label") or "")[:24], "fact": "", "bubble": "", "note": "", "title": ""}
            shots = [shot]
            if not short and n == 0:  # chapter title over the chapter's first picture
                shots.insert(0, dict(shot, kind="title", title=" ".join(str(chapters[i].get("title", "")).split()[:7]),
                                     camera="push_in", effect="none"))
            scenes.append({"narration": narration, "chapter": i, "shots": shots})
    return scenes, places


def write_script(job, sources):
    secs, words = target(job)
    short = job["format"] == "short"
    structure = random.choice(STRUCTURES)
    plan = plan_video(job, sources, structure)
    chapters = plan["chapters"][:1] if short else plan["chapters"]
    plan["chapters"] = chapters
    per = words // len(chapters)
    stills = job.get("style", "stills") == "stills"  # rich still pictures (the owner's choice, 2026-11-20)
    scenes, chapter_marks, previous, parts = [], [], "", []
    for i, ch in enumerate(chapters):
        time.sleep(4)  # stay well inside the free per-minute limit
        print(f"  writing part {i + 1} of {len(chapters)}", flush=True)
        if stills:
            part = write_chapter_stills(job, plan, sources, i, per, previous)
            parts.append(part)
        else:
            part = write_chapter(job, plan, sources, i, per, previous)
            for sc in part:
                sc["chapter"] = i
            scenes += part
        previous = " ".join(str(s.get("narration", "")) for s in part[-2:])[-400:]
    if stills:
        clean, places = stills_to_shots(parts, chapters, short)
        cast, guide = [], False
        if not places:
            raise WorkerError("The AI script had no pictures. It will try again within the hour.", transient=True)
    else:
        clean, cast, places, guide = tidy(plan, scenes, short)
    for i, ch in enumerate(chapters):
        first = next((n for n, sc in enumerate(clean) if sc["chapter"] == i), None)
        if first is not None:
            chapter_marks.append({"title": str(ch.get("title") or f"Part {i + 1}")[:60], "scene": first + 1})
    return {
        "working_title": plan.get("working_title", job["topic"]),
        "hook": plan.get("hook", ""),
        "structure": structure,
        "style": "stills" if stills else "animated-v2",
        "cast": cast,
        "places": places,
        "use_guide": guide,
        "chapters": [] if short else chapter_marks,
        "scenes": clean,
        "call_to_action": plan.get("call_to_action", ""),
        "why_it_matters": plan.get("why_it_matters", ""),
        "uses_realistic_altered_content": bool(plan.get("uses_realistic_altered_content")),
    }


def fact_check(job, script, sources):
    """Check narration and on-screen facts, in chunks so long videos fit."""
    refs = "\n\n".join(f"### {p['title']} ({p['url']})\n{p['text']}" for p in sources) or "(none)"
    lines = []
    for i, s in enumerate(script["scenes"]):
        extra = [sh[k] for sh in s.get("shots", []) for k in ("bubble", "note", "title") if sh.get(k)]
        lines.append(f"[{i + 1}] {s.get('narration', '')}" + (f" (on screen: {' | '.join(extra)})" if extra else ""))
    claims, summaries = [], []
    for start in range(0, len(lines), 90):
        if start:
            time.sleep(4)
        prompt = f"""You are a strict history fact-checker. Check every factual claim in this narration and its
on-screen text (names, dates, numbers, places, causes, quotes) against the reference material and well-established history.

Narration (scene numbers in brackets):
{chr(10).join(lines[start:start + 90])}

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
        if isinstance(result, dict):
            claims += [c for c in result.get("claims", []) if isinstance(c, dict)]
            if result.get("summary"):
                summaries.append(str(result["summary"]))
    for c in claims:
        c["verdict"] = str(c.get("verdict", "uncertain")).lower()
        if c["verdict"] not in ("supported", "uncertain", "wrong"):
            c["verdict"] = "uncertain"
    return {"claims": claims, "summary": " ".join(summaries[:3])}


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
            "estimated_seconds": round(words / WORDS_PER_SECOND),
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
