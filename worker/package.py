"""Package each finished video for YouTube: title, description, tags, chapters, thumbnail.

Runs after the video maker. For every job with status "video_ready" it writes
packages/<id>.json, adds thumbnail.jpg to the video's GitHub release (long
videos only: YouTube does not allow custom thumbnails on Shorts through its
API), and moves the job to "ready" (ready for the owner to review).
"""
import datetime
import os
import subprocess
import sys
import time

from common import ROOT, WorkerError, gemini_json, read_json, save, sync, write_json

SYSTEM = """You package videos for an original animated-history storytelling YouTube channel with a global audience.
Optimise for search and click-through honestly: the title and thumbnail must promise only what the video delivers.
No clickbait, no ALL CAPS titles, no misleading claims, no emojis in titles. Clear, simple English.
Answer only with JSON in the exact shape requested."""


def fmt_time(t):
    t = int(t)
    return f"{t // 3600}:{t % 3600 // 60:02d}:{t % 60:02d}" if t >= 3600 else f"{t // 60}:{t % 60:02d}"


def scene_starts(job, script):
    if job.get("scene_starts"):
        return job["scene_starts"]
    words = [len(str(s.get("narration", "")).split()) for s in script["scenes"]]
    total = sum(words) or 1
    secs = job.get("video_seconds") or total / 2.5
    out, t = [], 0.0
    for w in words:
        out.append(round(t, 2))
        t += secs * w / total
    return out


def build_chapters(raw, starts, video_seconds):
    """YouTube rules: first chapter at 0:00, at least 3 chapters, each at least 10 seconds."""
    picks = []
    for c in raw or []:
        try:
            i = max(0, min(len(starts) - 1, int(c.get("scene", 1)) - 1))
        except (TypeError, ValueError):
            continue
        title = str(c.get("title", "")).strip()[:60]
        if title:
            picks.append((starts[i], title))
    picks.sort()
    if not picks:
        return []
    picks[0] = (0.0, picks[0][1])
    clean = [picks[0]]
    for t, title in picks[1:]:
        if t - clean[-1][0] >= 10 and video_seconds - t >= 10:
            clean.append((t, title))
    return clean if len(clean) >= 3 else []


def trim_tags(tags, limit=450):
    out, used = [], 0
    for t in tags:
        t = str(t).strip().replace(",", "").replace("<", "").replace(">", "")
        if not t or t.lower() in (x.lower() for x in out):
            continue
        cost = len(t) + (2 if " " in t else 0) + 1
        if used + cost > limit:
            break
        out.append(t)
        used += cost
    return out


def write_package(job, script):
    short = job["format"] == "short"
    starts = scene_starts(job, script)
    scenes = "\n".join(f"[scene {i + 1} at {fmt_time(t)}] {s.get('narration', '')}" for i, (s, t) in enumerate(zip(script["scenes"], starts)))
    prompt = f"""Package this {'YouTube Short' if short else 'long YouTube video'} ({fmt_time(job.get('video_seconds', 0))} long).

Topic: {job['topic']}
Working title: {script.get('working_title', '')}
Why it matters: {script.get('why_it_matters', '')}
Audience: {job.get('audience', '')}

Narration with scene start times:
{scenes}

Return JSON:
{{
  "title_options": ["three different honest, curiosity-driven titles, each under 70 characters, main keyword early"],
  "title": "the best of the three",
  "description": "2 to 3 short paragraphs: first line restates the hook and includes the main search phrase; then what viewers will learn. No links, no chapters, no hashtags here.",
  "chapters": [{{"scene": 1, "title": "short chapter name"}}],
  "tags": ["10 to 15 search tags, most specific first"],
  "hashtags": ["#2 or 3 relevant hashtags"],
  "thumbnail_text": "2 to 4 punchy words for the thumbnail, not the same as the title",
  "thumbnail_visual": "one striking, simple illustration idea for the thumbnail, with one clear focal subject and space on the left for text"
}}
{"For a Short, return an empty chapters list." if short else "Give 4 to 8 chapters that follow the story, starting with scene 1."}"""
    pkg = gemini_json(prompt, SYSTEM, temperature=0.7)
    if not isinstance(pkg, dict) or not pkg.get("title"):
        raise WorkerError("The AI returned unusable titles. It will try again within the hour.", transient=True)

    raw = script.get("chapters") or pkg.get("chapters")  # long videos are written chapter by chapter
    chapters = [] if short else build_chapters(raw, starts, job.get("video_seconds", 0))
    hashtags = [h if str(h).startswith("#") else "#" + str(h) for h in pkg.get("hashtags", [])][:3]
    if short and "#Shorts" not in hashtags:
        hashtags.append("#Shorts")
    parts = [str(pkg.get("description", "")).strip()]
    if chapters:
        parts.append("Chapters\n" + "\n".join(f"{fmt_time(t)} {title}" for t, title in chapters))
    srcs = script.get("sources", [])
    if srcs:
        parts.append("Sources\n" + "\n".join(f"- {s['title']}: {s['url']}" for s in srcs))
    parts.append("About this video\nThe illustrations and the narrator's voice are AI-generated. The script was researched "
                 "from the sources above, fact-checked, and reviewed by a person before publishing. The music is original.")
    if hashtags:
        parts.append(" ".join(hashtags))
    description = "\n\n".join(p for p in parts if p)[:4900]

    title = str(pkg["title"]).strip()[:100]
    return {
        "job_id": job["id"],
        "created": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "title": title,
        "title_options": [str(t)[:100] for t in pkg.get("title_options", [])][:3],
        "description": description,
        "tags": trim_tags(pkg.get("tags", [])),
        "chapters": [{"time": fmt_time(t), "seconds": t, "title": c} for t, c in chapters],
        "hashtags": hashtags,
        "thumbnail_text": str(pkg.get("thumbnail_text", "")).strip()[:40],
        "thumbnail_visual": str(pkg.get("thumbnail_visual", "")).strip(),
        "category_id": "27",  # Education
        "made_for_kids": False,
        "ai_disclosure": bool(script.get("uses_realistic_altered_content")),
    }


def make_thumbnail(job, pkg, dest):
    """1280x720 JPEG: an illustration plus big readable words, in the channel's style."""
    from PIL import Image, ImageDraw, ImageFilter, ImageFont

    import render_video as rv

    raw = dest.with_suffix(".src.png")
    visual = pkg.get("thumbnail_visual") or pkg["title"]
    if not rv.illustrate(f"{visual}. Bold, high-contrast, close-up focal subject on the right, simple uncluttered background",
                         1344, 832, abs(hash(job["id"])) % 100000, raw):
        raise WorkerError("The thumbnail picture could not be made. It will try again within the hour.", transient=True)
    im = Image.open(raw).convert("RGB")
    im = im.crop((0, 0, im.width, int(im.height * 0.92)))  # cut the free service's mark
    scale = max(1280 / im.width, 720 / im.height)
    im = im.resize((round(im.width * scale), round(im.height * scale)), Image.LANCZOS)
    left, top = (im.width - 1280) // 2, (im.height - 720) // 2
    im = im.crop((left, top, left + 1280, top + 720))

    # soft dark band on the left so the words always read
    shade = Image.new("L", (1280, 720), 0)
    d = ImageDraw.Draw(shade)
    for x in range(760):
        d.line([(x, 0), (x, 720)], fill=int(190 * (1 - x / 760) ** 1.4))
    im = Image.composite(Image.new("RGB", im.size, (12, 16, 22)), im, shade)

    font_path = rv.CACHE / "fonts" / "Anton-Regular.ttf"
    if not font_path.exists():
        try:
            font_path.parent.mkdir(parents=True, exist_ok=True)
            rv.download(rv.FONT_URL, font_path)
        except Exception as e:
            print(f"Font download failed: {e}", flush=True)
    words = (pkg.get("thumbnail_text") or pkg["title"]).upper().split()
    lines, cur = [], []
    for w in words:  # at most ~12 characters per line
        if cur and len(" ".join(cur + [w])) > 12:
            lines.append(" ".join(cur))
            cur = []
        cur.append(w)
    if cur:
        lines.append(" ".join(cur))
    lines = lines[:3]
    size = {1: 190, 2: 150, 3: 118}[len(lines)]
    try:
        font = ImageFont.truetype(str(font_path), size)
    except OSError:
        font = ImageFont.load_default(size=size)
    draw = ImageDraw.Draw(im)
    line_h = int(size * 1.08)
    y = (720 - line_h * len(lines)) // 2
    for i, line in enumerate(lines):
        fill = (245, 196, 82) if i == len(lines) - 1 else (255, 255, 255)  # last line in warm ochre
        draw.text((60, y), line, font=font, fill=fill, stroke_width=max(4, size // 22), stroke_fill=(10, 10, 10))
        y += line_h
    im = im.filter(ImageFilter.UnsharpMask(radius=2, percent=60, threshold=3))
    im.save(dest, "JPEG", quality=88, optimize=True)
    return dest


def upload_asset(job, path):
    repo = os.environ.get("GITHUB_REPOSITORY")
    if not repo:
        return str(path)
    tag = f"video-{job['id']}"
    r = subprocess.run(["gh", "release", "upload", tag, str(path), "--clobber"], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr[-500:])
    return f"https://github.com/{repo}/releases/download/{tag}/{path.name}"


def process(path):
    sync()
    job = read_json(path)
    if not job or job.get("status") != "video_ready":
        return False
    only = os.environ.get("RENDER_FORMAT", "").strip()
    if only and job.get("format") != only:
        return False  # the other video maker packages this one
    script = read_json(ROOT / "scripts" / f"{job['id']}.json")
    if not script:
        return False
    print(f"Packaging {job['id']}: {job['topic']}", flush=True)
    try:
        pkg = write_package(job, script)
        if job["format"] == "long":
            work = ROOT / ".tmp"
            work.mkdir(exist_ok=True)
            thumb = make_thumbnail(job, pkg, work / "thumbnail.jpg")
            pkg["thumbnail"] = upload_asset(job, thumb)
        else:
            pkg["thumbnail"] = None
            pkg["thumbnail_note"] = "YouTube picks the cover frame for Shorts. You can change it in the YouTube app."
        write_json(ROOT / "packages" / f"{job['id']}.json", pkg)
        job["status"] = "ready"
        job["title"] = pkg["title"]
        job.pop("error", None)
        job.pop("package_attempts", None)
    except Exception as e:
        print(repr(e), file=sys.stderr)
        job["package_attempts"] = job.get("package_attempts", 0) + 1
        msg = str(e) if isinstance(e, WorkerError) else f"Something went wrong making the title and thumbnail ({type(e).__name__})."
        if job["package_attempts"] >= 3:
            job["status"] = "failed"
            job["failed_step"] = "package"
            msg += " Tap Try again in the Queue."
        job["error"] = msg
    job["updated"] = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    write_json(path, job)
    save(["jobs", "packages"], f"Packaging {'ready' if job['status'] == 'ready' else 'update'}: {job['topic'][:60]}")
    return True


def main():
    done = 0
    for path in sorted((ROOT / "jobs").glob("*.json")):
        if process(path):
            done += 1
            time.sleep(3)
    print(f"Packaged {done} video(s).")


if __name__ == "__main__":
    main()
