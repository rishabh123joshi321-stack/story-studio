"""Feature: subtitles and titles in other languages.

For every packaged video ("ready" or later) that has no subtitles yet, this writes:
  - English subtitles (.srt) timed to the narration,
  - translated subtitles and a translated title + description for each language in the job's
    subtitle_langs (set in the app; default Hindi and Spanish).
The .srt files go on the video's GitHub release; packages/<id>.json gets "subtitles" and "localized".
The uploader adds them to YouTube when the sign-in allows it; otherwise the owner can add them in Studio.
Uses one AI request per language-batch (about 1 for a Short, 2 to 3 for a 40-minute video).
"""
import os
import pathlib
import sys
import time

from common import ROOT, WorkerError, gemini_json, read_json, save, sync, write_json

LANG_NAMES = {"hi": "Hindi", "es": "Spanish", "pt": "Portuguese", "fr": "French", "de": "German", "ar": "Arabic", "id": "Indonesian", "ja": "Japanese"}
WORK = pathlib.Path(os.environ.get("SS_WORK", "/tmp/ss-render")) / "subs"
CHUNK = 60


def ts(t):
    ms = int(round(t * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


def srt(lines, starts, total):
    """One subtitle block per ~10 words, timed in proportion within each scene."""
    out, n = [], 1
    ends = list(starts[1:]) + [total]
    for text, a, b in zip(lines, starts, ends):
        words = str(text).split()
        if not words:
            continue
        parts = [words[i:i + 10] for i in range(0, len(words), 10)]
        span = max(0.5, b - a)
        t = a
        for p in parts:
            d = span * len(p) / len(words)
            out.append(f"{n}\n{ts(t)} --> {ts(min(b, t + d) - 0.05)}\n{' '.join(p)}\n")
            n += 1
            t += d
    return "\n".join(out)


def translate(title, desc, lines, langs):
    """Returns {lang: {"title", "description", "lines"}}."""
    names = ", ".join(f'"{l}" ({LANG_NAMES[l]})' for l in langs)
    result = {l: {"title": "", "description": "", "lines": []} for l in langs}
    for start in range(0, len(lines), CHUNK):
        part = lines[start:start + CHUNK]
        head = start == 0
        numbered = "\n".join(f"[{i + 1}] {t}" for i, t in enumerate(part))
        prompt = f"""Translate this YouTube history video's {'title, description and ' if head else ''}narration lines into: {names}.
Keep names, dates and numbers exact. Natural, simple, spoken style (these are subtitles). Keep the same number of lines, in order.
{f'Title: {title}{chr(10)}Description: {desc}{chr(10)}' if head else ''}
Narration lines:
{numbered}

Return JSON: {{{", ".join(f'"{l}": {{{chr(34)}title{chr(34)}: "...", "description": "...", "lines": ["one string per narration line"]}}' for l in langs)}}}"""
        if start:
            time.sleep(4)
        res = gemini_json(prompt, "You are a careful professional translator. Answer only with JSON.", temperature=0.2)
        if not isinstance(res, dict):
            raise WorkerError("Translation failed.", transient=True)
        for l in langs:
            got = res.get(l) or {}
            got_lines = [str(x) for x in (got.get("lines") or [])]
            if len(got_lines) != len(part):  # never mis-time subtitles: pad or cut to match
                got_lines = (got_lines + part[len(got_lines):])[:len(part)]
            result[l]["lines"] += got_lines
            if head:
                result[l]["title"] = str(got.get("title", ""))[:100]
                result[l]["description"] = str(got.get("description", ""))[:4500]
    return result


def upload_asset(job, path):
    from package import upload_asset as up
    return up(job, path)


def process(path):
    sync()
    job = read_json(path)
    if not job or job.get("status") not in ("ready", "approved", "post_yourself") or job.get("subs_done"):
        return False
    only = os.environ.get("RENDER_FORMAT", "").strip()  # long run: long videos + their Shorts; short run: other Shorts
    if only == "long" and job.get("format") != "long" and not job.get("parent_id"):
        return False
    if only == "short" and (job.get("format") != "short" or job.get("parent_id")):
        return False
    pkg_path = ROOT / "packages" / f"{job['id']}.json"
    pkg, script = read_json(pkg_path), read_json(ROOT / "scripts" / f"{job['id']}.json")
    starts, total = job.get("scene_starts"), job.get("video_seconds")
    if not pkg or not script or not starts or not total:
        return False
    lines = [s.get("narration", "") for s in script["scenes"]][:len(starts)]
    langs = [l for l in job.get("subtitle_langs", ["hi", "es"]) if l in LANG_NAMES][:4]
    folder = WORK / job["id"]
    folder.mkdir(parents=True, exist_ok=True)
    subs = {}
    try:
        (folder / "subtitles-en.srt").write_text(srt(lines, starts, total), encoding="utf-8")
        subs["en"] = upload_asset(job, folder / "subtitles-en.srt")
        localized = {}
        if langs:
            first_para = str(pkg.get("description", "")).split("\n\n")[0]
            tr = translate(pkg.get("title", ""), first_para, lines, langs)
            for l, d in tr.items():
                f = folder / f"subtitles-{l}.srt"
                f.write_text(srt(d["lines"], starts, total), encoding="utf-8")
                subs[l] = upload_asset(job, f)
                if d["title"]:
                    localized[l] = {"title": d["title"], "description": d["description"]}
        sync()
        pkg = read_json(pkg_path) or pkg
        pkg["subtitles"], pkg["localized"] = subs, localized
        write_json(pkg_path, pkg)
        job = read_json(path) or job
        job["subs_done"] = True
        write_json(path, job)
        save(["jobs", "packages"], f"Subtitles: {job['topic'][:60]}")
        print(f"Subtitles for {job['id']}: {', '.join(subs)}", flush=True)
        return True
    except Exception as e:  # subtitles are a bonus: never block the video
        print(f"Subtitles for {job['id']} skipped for now: {e!r}", file=sys.stderr)
        return False


def main():
    for p in sorted((ROOT / "jobs").glob("*.json")):
        process(p)


if __name__ == "__main__":
    main()
