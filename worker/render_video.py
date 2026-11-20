"""Turn a written script into a finished video.

For each job with status "script_ready":
  1. Illustrate every scene with a free AI image service, in the house style.
  2. Read the narration with Kokoro, an open-source voice (Apache 2.0 licence).
  3. Make original background music (see music.py).
  4. Add gentle camera motion, soft crossfades and burned-in captions with ffmpeg.
  5. Upload the MP4 to a GitHub release and mark the job "video_ready".
"""
import datetime
import hashlib
import json
import os
import pathlib
import random
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

import numpy as np
import soundfile as sf

from common import HOUSE_STYLE, ROOT, UA, WorkerError, read_json, save, stale, sync, write_json
from music import SR, make_music

CACHE = pathlib.Path(os.environ.get("SS_CACHE", pathlib.Path.home() / ".cache" / "storystudio"))
WORK = pathlib.Path(os.environ.get("SS_WORK", "/tmp/ss-render"))
MAX_RENDERS = int(os.environ.get("MAX_RENDERS", "2"))
FPS = 30
XFADE = 0.5  # seconds of crossfade between scenes
PAUSE = 0.35  # breath after each scene's narration

VOICES = {  # Kokoro voices: (voice, accent)
    "en-US-male": ("am_michael", "en-us"),
    "en-GB-male": ("bm_george", "en-gb"),
    "en-IN-male": ("hm_omega", "en-us"),  # Indian-English flavour (experimental)
}
MOTIONS = {
    "slow zoom in": ("1.0+0.10*on/{n}", "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"),
    "slow zoom out": ("1.10-0.10*on/{n}", "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"),
    "pan left": ("1.10", "(iw-iw/zoom)*(1-on/{n})", "ih/2-(ih/zoom/2)"),
    "pan right": ("1.10", "(iw-iw/zoom)*on/{n}", "ih/2-(ih/zoom/2)"),
    "drift up": ("1.10", "iw/2-(iw/zoom/2)", "(ih-ih/zoom)*(1-on/{n})"),
    "drift down": ("1.10", "iw/2-(iw/zoom/2)", "(ih-ih/zoom)*on/{n}"),
}
FONT_URL = "https://github.com/google/fonts/raw/main/ofl/anton/Anton-Regular.ttf"  # SIL Open Font License


def log(*a):
    print(*a, flush=True)


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"{cmd[0]} failed: {r.stderr[-1500:]}")
    return r.stdout


def download(url, dest, timeout=180):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r, open(dest, "wb") as f:
        shutil.copyfileobj(r, f)
    return dest


# ---------------------------------------------------------------- pictures
def image_pollinations(prompt, w, h, seed, dest):
    q = urllib.parse.urlencode({"width": w, "height": h, "seed": seed, "model": "flux", "nologo": "true", "private": "true"})
    url = "https://image.pollinations.ai/prompt/" + urllib.parse.quote(prompt[:900]) + "?" + q
    download(url, dest, timeout=240)
    head = open(dest, "rb").read(12)
    if not (head.startswith(b"\x89PNG") or head[:3] == b"\xff\xd8\xff" or head[8:12] == b"WEBP"):
        raise RuntimeError("not an image")
    return dest


def image_gemini(prompt, w, h, seed, dest):
    key = os.environ.get("GEMINI_API_KEY", "")
    if not key:
        raise RuntimeError("no key")
    model = os.environ.get("GEMINI_IMAGE_MODEL", "gemini-2.5-flash-image")
    aspect = "9:16" if h > w else "16:9"
    body = {"contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"responseModalities": ["IMAGE"], "imageConfig": {"aspectRatio": aspect}}}
    req = urllib.request.Request(
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
        data=json.dumps(body).encode(), headers={"x-goog-api-key": key, "Content-Type": "application/json", "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=180) as r:
        res = json.loads(r.read())
    import base64
    for p in res.get("candidates", [{}])[0].get("content", {}).get("parts", []):
        if "inlineData" in p:
            pathlib.Path(dest).write_bytes(base64.b64decode(p["inlineData"]["data"]))
            return dest
    raise RuntimeError("no image returned")


PROVIDERS = [("pollinations", image_pollinations), ("gemini", image_gemini)]
GAP = {"pollinations": 47}  # free tier: one picture every 45 seconds
_dead = set()
_last = {}


def _wait_turn(name, extra=0):
    gap = max(GAP.get(name, 0), extra)
    wait = _last.get(name, 0) + gap - time.time()
    if wait > 0:
        time.sleep(wait)
    _last[name] = time.time()


def illustrate(visual, w, h, seed, dest):
    prompt = f"{visual}. Style: {HOUSE_STYLE}."
    for name, fn in PROVIDERS:
        if name in _dead:
            continue
        extra = 0
        for attempt in range(4):
            _wait_turn(name, extra)
            try:
                fn(prompt, w, h, seed + attempt, dest)
                return name
            except urllib.error.HTTPError as e:
                detail = e.read()[:300]
                log(f"  {name} image HTTP {e.code} {detail[:160]!r}")
                if e.code in (401, 403, 404) or (name == "gemini" and e.code == 429):
                    _dead.add(name)  # no free quota for this service: stop asking
                    break
                m = re.search(rb"[Rr]etry after (\d+)", detail)
                extra = (int(m.group(1)) + 2) if m else 20 * (attempt + 1)
            except Exception as e:
                log(f"  {name} image error: {e}")
                time.sleep(8 * (attempt + 1))
    return None


# ---------------------------------------------------------------- voice
_tts = None


def tts():
    global _tts
    if _tts is None:
        from kokoro_onnx import Kokoro
        base = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"
        CACHE.mkdir(parents=True, exist_ok=True)
        for f in ("kokoro-v1.0.onnx", "voices-v1.0.bin"):
            if not (CACHE / f).exists():
                log(f"Downloading voice model {f}...")
                download(base + f, CACHE / f, timeout=600)
        _tts = Kokoro(str(CACHE / "kokoro-v1.0.onnx"), str(CACHE / "voices-v1.0.bin"))
    return _tts


def speak(text, voice_key, dest):
    voice, lang = VOICES.get(voice_key, VOICES["en-US-male"])
    audio, sr = tts().create(text, voice=voice, lang=lang, speed=1.0)
    if sr != SR:
        raise RuntimeError(f"unexpected sample rate {sr}")
    audio = np.concatenate([audio, np.zeros(int(PAUSE * SR), dtype=np.float32)])
    sf.write(dest, audio, SR)
    return len(audio) / SR


# ---------------------------------------------------------------- captions
def ass_time(t):
    t = max(0, t)
    return f"{int(t // 3600)}:{int(t % 3600 // 60):02d}:{t % 60:05.2f}"


def captions(scenes, starts, durs, w, h, vertical, dest):
    size = 96 if vertical else 68
    margin = int(h * 0.27) if vertical else 70
    per = 3 if vertical else 7
    lines = [
        "[Script Info]", "ScriptType: v4.00+", f"PlayResX: {w}", f"PlayResY: {h}", "WrapStyle: 0", "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        f"Style: Cap,Anton,{size},&H00FFFFFF,&H00FFFFFF,&H00161616,&H64000000,0,0,0,0,100,100,1,0,1,{6 if vertical else 4},2,2,60,60,{margin},1",
        "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    for sc, start, dur in zip(scenes, starts, durs):
        words = str(sc.get("narration", "")).split()
        if not words:
            continue
        chunks = [words[i:i + per] for i in range(0, len(words), per)]
        speak_time = max(0.5, dur - PAUSE)
        weights = [sum(len(x) + 1 for x in c) for c in chunks]
        total = sum(weights)
        t = start
        for c, wgt in zip(chunks, weights):
            d = speak_time * wgt / total
            text = " ".join(c).replace("{", "(").replace("}", ")")
            if vertical:
                text = text.upper()
            lines.append(f"Dialogue: 0,{ass_time(t)},{ass_time(t + d)},Cap,,0,0,0,,{text}")
            t += d
    pathlib.Path(dest).write_text("\n".join(lines) + "\n", encoding="utf-8")


# ---------------------------------------------------------------- assembly
def render(job, script, out_dir):
    vertical = job["format"] == "short"
    W, H = (1080, 1920) if vertical else (1920, 1080)
    gw, gh = (768, 1456) if vertical else (1344, 832)  # generation size, a bit taller; bottom strip is cut later
    scenes = [s for s in script.get("scenes", []) if str(s.get("narration", "")).strip()]
    if not scenes:
        raise WorkerError("The script has no scenes to turn into a video.")
    seed0 = int(hashlib.sha1(f"{job['id']}-{job.get('revision', 0)}".encode()).hexdigest()[:6], 16)  # new pictures on each redo

    # 1. voice
    log(f"Voice for {len(scenes)} scenes...")
    durs = []
    for i, sc in enumerate(scenes):
        durs.append(max(2.5, speak(sc["narration"], job.get("voice", "en-US-male"), out_dir / f"v{i:03d}.wav")))
    # pad any short scene up to its minimum duration
    parts = []
    for i, d in enumerate(durs):
        a = sf.read(out_dir / f"v{i:03d}.wav", dtype="float32")[0]
        need = int(d * SR) - len(a)
        parts.append(np.concatenate([a, np.zeros(max(0, need), dtype=np.float32)]))
    voice = np.concatenate(parts)
    sf.write(out_dir / "voice.wav", voice, SR)
    total = len(voice) / SR
    starts = np.concatenate([[0], np.cumsum(durs)[:-1]]).tolist()

    # 2. pictures
    log("Pictures...")
    got = {}
    for i, sc in enumerate(scenes):
        dest = out_dir / f"img{i:03d}.png"
        src = illustrate(sc.get("visual") or sc["narration"], gw, gh, seed0 + i * 7, dest)
        if src:
            got[i] = dest
            log(f"  scene {i + 1}: {src}")
        else:
            log(f"  scene {i + 1}: no picture")
    if len(got) < max(1, int(len(scenes) * 0.6)):
        raise WorkerError(f"Only {len(got)} of {len(scenes)} pictures could be made (the free image service may be busy). "
                          "It will try again within the hour.", transient=True)
    images = []
    for i in range(len(scenes)):  # reuse the nearest picture for any gap
        j = min(got, key=lambda k: abs(k - i))
        images.append(got[j])

    # 3. music
    log("Music...")
    music = make_music(total + 1, job.get("tone", ""), seed=seed0)
    own = sorted((ROOT / "music").glob("*.mp3")) if (ROOT / "music").exists() else []
    music_path = out_dir / "music.wav"
    if own:
        music_path = random.Random(seed0).choice(own)
        log(f"  using your track {music_path.name}")
    else:
        sf.write(music_path, music, SR)

    # 4. captions
    fonts = CACHE / "fonts"
    fonts.mkdir(parents=True, exist_ok=True)
    if not (fonts / "Anton-Regular.ttf").exists():
        try:
            download(FONT_URL, fonts / "Anton-Regular.ttf")
        except Exception as e:
            log(f"Font download failed ({e}); captions use the default font.")
    captions(scenes, starts, durs, W, H, vertical, out_dir / "captions.ass")

    # 5. video: each picture with gentle motion, crossfaded, captions burned in
    log("Assembling video...")
    inputs, filters = [], []
    sw, sh = int(W * 1.5), int(H * 1.5)
    for i, (img, d) in enumerate(zip(images, durs)):
        clip = d + (XFADE if i < len(scenes) - 1 else 0)
        n = max(2, int(round(clip * FPS)))
        motion = str(scenes[i].get("motion", "")).strip().lower()
        z, x, y = MOTIONS.get(motion) or list(MOTIONS.values())[i % len(MOTIONS)]
        inputs += ["-i", str(img)]
        filters.append(
            f"[{i}:v]crop=iw:trunc(ih*0.92/2)*2:0:0,scale={sw}:{sh}:force_original_aspect_ratio=increase:flags=lanczos,crop={sw}:{sh},"
            f"zoompan=z='{z.format(n=n)}':x='{x.format(n=n)}':y='{y.format(n=n)}':d={n}:s={W}x{H}:fps={FPS},"
            f"setsar=1,format=yuv420p,trim=end_frame={n}[c{i}]")
    last = "c0"
    for i in range(1, len(scenes)):
        offset = sum(durs[:i])
        filters.append(f"[{last}][c{i}]xfade=transition=fade:duration={XFADE}:offset={offset:.3f}[x{i}]")
        last = f"x{i}"
    subs = str(out_dir / "captions.ass").replace(":", r"\:")
    filters.append(f"[{last}]subtitles='{subs}':fontsdir='{fonts}'[vout]")
    a_voice, a_music = len(images), len(images) + 1
    filters.append(f"[{a_music}:a]aloop=loop=-1:size=2e9,atrim=0:{total:.2f},lowpass=f=2200,volume=0.22[m]")
    filters.append(f"[{a_voice}:a]asplit=2[v1][vv]")
    filters.append(f"[m][v1]sidechaincompress=threshold=0.03:ratio=6:attack=30:release=600[md]")
    filters.append(f"[vv][md]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11[aout]")
    graph = out_dir / "graph.txt"
    graph.write_text(";\n".join(filters))
    out = out_dir / "video.mp4"
    run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", *inputs,
         "-i", str(out_dir / "voice.wav"), "-i", str(music_path),
         "-filter_complex", graph.read_text(), "-map", "[vout]", "-map", "[aout]",
         "-c:v", "libx264", "-preset", os.environ.get("X264_PRESET", "veryfast"), "-crf", "21", "-pix_fmt", "yuv420p",
         "-r", str(FPS), "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-t", f"{total:.2f}",
         "-movflags", "+faststart", str(out)])
    return out, total, [round(x, 2) for x in starts]


def publish(job, video):
    """Upload to a GitHub release (free storage, up to 2 GB per file)."""
    repo = os.environ.get("GITHUB_REPOSITORY")
    if not repo:
        log("Not running on GitHub; skipping upload.")
        return str(video)
    tag = f"video-{job['id']}"
    subprocess.run(["gh", "release", "delete", tag, "--yes", "--cleanup-tag"], capture_output=True)
    run(["gh", "release", "create", tag, str(video), "--title", f"Video: {job['topic'][:80]}",
         "--notes", "Made by Story Studio. Not uploaded to YouTube until approved in the app.",
         "--prerelease", "--latest=false"])
    return f"https://github.com/{repo}/releases/download/{tag}/video.mp4"


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def process(path):
    sync()
    job = read_json(path)
    if job and job.get("status") == "rendering" and stale(job, 180):
        job["status"] = "script_ready"
    if not job or job.get("status") != "script_ready":
        return False
    script = read_json(ROOT / "scripts" / f"{job['id']}.json")
    if not script:
        return False
    log(f"=== Making video for {job['id']}: {job['topic']}")
    job["status"] = "rendering"
    job["updated"] = now()
    job.pop("error", None)
    write_json(path, job)
    save(["jobs"], f"Making video: {job['topic'][:60]}")
    out_dir = WORK / job["id"]
    out_dir.mkdir(parents=True, exist_ok=True)
    started = time.time()
    try:
        video, secs, starts = render(job, script, out_dir)
        url = publish(job, video)
        job.update(status="video_ready", video=url, video_seconds=round(secs, 1), scene_starts=starts,
                   render_minutes=round((time.time() - started) / 60, 1))
        job.pop("render_attempts", None)
        log(f"Done in {job['render_minutes']} min: {url}")
    except Exception as e:
        print(repr(e), file=sys.stderr)
        job["render_attempts"] = job.get("render_attempts", 0) + 1
        transient = getattr(e, "transient", not isinstance(e, WorkerError))
        msg = str(e) if isinstance(e, WorkerError) else f"Something went wrong making the video ({type(e).__name__})."
        if transient and job["render_attempts"] < 3:
            job["status"] = "script_ready"
            job["error"] = msg
        else:
            job["status"] = "failed"
            job["failed_step"] = "video"
            job["error"] = msg + " Tap Try again in the Queue."
    job["updated"] = now()
    write_json(path, job)
    save(["jobs"], f"Video {'ready' if job['status'] == 'video_ready' else 'update'}: {job['topic'][:60]}")
    shutil.rmtree(out_dir, ignore_errors=True)
    return True


def main():
    only = os.environ.get("ONLY_JOB", "").strip()
    done = 0
    for path in sorted((ROOT / "jobs").glob("*.json")):
        job = read_json(path, {})
        if job.get("status") not in ("script_ready", "rendering") or (only and job.get("id") != only):
            continue
        if done >= MAX_RENDERS:
            break
        if process(path):
            done += 1
    log(f"Made {done} video(s).")


if __name__ == "__main__":
    main()
