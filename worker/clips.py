"""Feature: a Short cut from every long video (no extra pictures needed).

After a long video is packaged ("ready"), this takes its opening hook: whole scenes adding up to
40-58 seconds, places the wide video on a vertical 1080x1920 canvas over a blurred copy of itself,
adds the video's title above it and "Full story on the channel" below, and creates a new Short job
("video_ready"), which package.py then gives its own title and description.
Runs inside the long-video maker after packaging. Uses no AI quota and no picture quota.
"""
import datetime
import os
import pathlib
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont

from common import ROOT, read_json, save, sync, write_json
from render_video import CACHE, caption_font, log, publish

WORK = pathlib.Path(os.environ.get("SS_WORK", "/tmp/ss-render")) / "clips"
MIN_S, MAX_S = 40.0, 58.0


def pick_segment(starts, total):
    """Whole scenes from the start, as long as possible but at most 58 s."""
    ends = list(starts[1:]) + [total]
    end_i = 0
    for i, e in enumerate(ends):
        if e <= MAX_S:
            end_i = i
        else:
            break
    dur = ends[end_i]
    if dur < MIN_S:  # one scene longer than the window: just take the first 58 s
        dur = min(MAX_S, total)
    return end_i + 1, round(dur, 2)


def text_layer(title, font_name, dest):
    """Transparent 1080x1920 picture with the title at the top and a note at the bottom."""
    name = caption_font(font_name)[0]
    from render_video import CAPTION_FONTS
    path = CACHE / "fonts" / CAPTION_FONTS[name][0].rsplit("/", 1)[1]
    if not path.exists():  # font download failed: fall back to a system font
        path = next((q for q in (pathlib.Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),) if q.exists()), path)
    img = Image.new("RGBA", (1080, 1920), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    def fit(text, size, maxw):
        while size > 30:
            f = ImageFont.truetype(str(path), size)
            words, lines, cur = text.split(), [], ""
            for w in words:
                t = (cur + " " + w).strip()
                if d.textlength(t, font=f) <= maxw:
                    cur = t
                else:
                    lines.append(cur)
                    cur = w
            lines.append(cur)
            if len(lines) <= 3:
                return f, lines
            size -= 6
        return ImageFont.truetype(str(path), 30), [text[:40]]

    f, lines = fit(title.upper() if CAPTION_FONTS[name][3] else title, 92, 960)
    y = 300
    for ln in lines:
        w = d.textlength(ln, font=f)
        d.text(((1080 - w) / 2, y), ln, font=f, fill="white", stroke_width=6, stroke_fill="black")
        y += int(f.size * 1.12)
    f2 = ImageFont.truetype(str(path), 58)
    note = "FULL STORY ON THE CHANNEL" if CAPTION_FONTS[name][3] else "Full story on the channel"
    w = d.textlength(note, font=f2)
    d.text(((1080 - w) / 2, 1500), note, font=f2, fill=(240, 178, 90), stroke_width=4, stroke_fill="black")
    img.save(dest)


def make_clip(src, start, dur, overlay, dest):
    flt = ("[0:v]split[a][b];[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=30:3,eq=brightness=-0.12[bg];"
           "[b]scale=1080:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2[v1];[v1][1:v]overlay=0:0[v]")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", str(start), "-t", str(dur), "-i", str(src), "-i", str(overlay),
                    "-filter_complex", flt, "-map", "[v]", "-map", "0:a?", "-c:v", "libx264", "-preset", "medium", "-crf", "20",
                    "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-r", "30", "-movflags", "+faststart", str(dest)], check=True)


def process(path):
    sync()
    job = read_json(path)
    if not job or job.get("format") != "long" or job.get("clip_made") or job.get("parent_id"):
        return False
    if job.get("status") not in ("ready", "approved", "post_yourself", "uploading", "uploaded", "posted"):
        return False
    script = read_json(ROOT / "scripts" / f"{job['id']}.json")
    pkg = read_json(ROOT / "packages" / f"{job['id']}.json") or {}
    starts = job.get("scene_starts")
    if not script or not starts or not job.get("video_seconds"):
        return False
    folder = WORK / job["id"]
    folder.mkdir(parents=True, exist_ok=True)
    src = folder / "long.mp4"
    r = subprocess.run(["gh", "release", "download", f"video-{job['id']}", "-p", "video.mp4", "-O", str(src), "--clobber"],
                       capture_output=True, text=True)
    if r.returncode != 0:
        log("Could not download the long video:", r.stderr[-300:])
        return False
    n, dur = pick_segment(starts, job["video_seconds"])
    title = pkg.get("title") or job.get("title") or job["topic"]
    text_layer(title, job.get("captionFont", "Anton"), folder / "text.png")
    out = folder / "video.mp4"
    make_clip(src, 0, dur, folder / "text.png", out)
    cid = f"{job['id']}-s1"
    now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    clip = {k: job.get(k) for k in ("tone", "audience", "voice", "captionFont", "theme")}
    clip.update(id=cid, parent_id=job["id"], created=now, updated=now, format="short", length=round(dur), lengthUnit="seconds",
                topic=f"{job['topic']} (Short)", notes="Cut from the long video.", status="video_ready",
                video_seconds=dur, scene_starts=[s for s in starts[:n]])
    clip["video"] = publish(clip, out)
    sub = dict(script)
    sub["scenes"] = script["scenes"][:n]
    sub.pop("chapters", None)
    sub["working_title"] = title
    sub["clip_of"] = job["id"]
    write_json(ROOT / "scripts" / f"{cid}.json", sub)
    write_json(ROOT / "jobs" / f"{cid}.json", clip)
    job["clip_made"] = cid
    write_json(path, job)
    save(["jobs", "scripts"], f"Short cut from: {job['topic'][:60]}")
    subprocess.run(["rm", "-rf", str(folder)])
    log(f"Made Short {cid} ({dur:.0f} s)")
    return True


def main():
    if os.environ.get("RENDER_FORMAT", "long") != "long":
        return
    for p in sorted((ROOT / "jobs").glob("*.json")):
        try:
            process(p)
        except Exception as e:  # a failed clip never blocks anything else
            print(f"Clip for {p.stem} failed: {e!r}", file=sys.stderr)


if __name__ == "__main__":
    main()
