"""Turn a written script into a finished video.

For each job with status "script_ready":
  1. Read the narration with Kokoro, an open-source voice (Apache 2.0 licence).
  2. Draw empty painted backgrounds and every character pose (on white, then cut out) with a free AI image service.
  3. Animate it shot by shot like a cut-out cartoon (animate.py): characters walk, run, jump and swap poses,
     things fly and fall, fire and rain move, the camera pushes, pans and shakes, with year labels and fact cards.
  4. Add original music (music.py) and burned-in captions.
  5. Upload the MP4 to a GitHub release and mark the job "video_ready".
"""
import datetime
import hashlib
import json
import math
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

from common import ordered_jobs, not_yet, HOUSE_STYLE, ROOT, UA, WorkerError, read_json, save, stale, sync, write_json
from music import SR, make_music
from overlays import cut_out_white, ensure_host, font, host_pose, sprite_prompt

CACHE = pathlib.Path(os.environ.get("SS_CACHE", pathlib.Path.home() / ".cache" / "storystudio"))
WORK = pathlib.Path(os.environ.get("SS_WORK", "/tmp/ss-render"))
MAX_RENDERS = int(os.environ.get("MAX_RENDERS", "2"))
FPS = 30
PAUSE = 0.35  # breath after each scene's narration

VOICES = {  # Kokoro voices: (voice, accent)
    "en-US-male": ("am_michael", "en-us"),
    "en-GB-male": ("bm_george", "en-gb"),
    "en-IN-male": ("hm_omega", "en-us"),  # Indian-English flavour (experimental)
}
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


def image_cloudflare(prompt, w, h, seed, dest):
    """FLUX.1 schnell on Cloudflare Workers AI (free daily allowance, about 170 pictures a day)."""
    acct, token = os.environ.get("CF_ACCOUNT_ID", "").strip(), os.environ.get("CF_API_TOKEN", "").strip()
    if not (acct and token):
        raise RuntimeError("not set up")
    url = f"https://api.cloudflare.com/client/v4/accounts/{acct}/ai/run/@cf/black-forest-labs/flux-1-schnell"
    req = urllib.request.Request(url, data=json.dumps({"prompt": prompt[:2000], "steps": 4}).encode(),  # this model takes no seed
                                 headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=180) as r:
        res = json.loads(r.read())
    img = (res.get("result") or {}).get("image")
    if not img:
        raise RuntimeError(f"no image returned: {str(res)[:200]}")
    import base64
    pathlib.Path(dest).write_bytes(base64.b64decode(img))
    return dest


def _fit(dest, w, h, provider):
    """Same shape from every service: no watermark strip, the requested aspect, the requested size."""
    from PIL import Image
    im = Image.open(dest).convert("RGB")
    if provider == "pollinations":
        im = im.crop((0, 0, im.width, int(im.height * 0.92)))  # the free service's mark
    tw, th = w, int(h * 0.92)
    scale = max(tw / im.width, th / im.height)
    im = im.resize((max(tw, round(im.width * scale)), max(th, round(im.height * scale))), Image.LANCZOS)
    left, top = (im.width - tw) // 2, (im.height - th) // 2
    im.crop((left, top, left + tw, top + th)).save(dest, "PNG")


class PicturesUsedUp(WorkerError):
    def __init__(self):
        super().__init__("Today's free pictures are used up. The video continues automatically after 5:30 AM India time.",
                         transient=True)


CLOUDFLARE = bool(os.environ.get("CF_ACCOUNT_ID") and os.environ.get("CF_API_TOKEN"))
# With Cloudflare set up, only Cloudflare is used, so every picture in a video has the same look.
PROVIDERS = [("cloudflare", image_cloudflare)] if CLOUDFLARE else [("pollinations", image_pollinations)]
GAP = {"pollinations": 47}  # free tier: one picture every 45 seconds
_dead = set()
_last = {}


def _wait_turn(name, extra=0):
    gap = max(GAP.get(name, 0), extra)
    wait = _last.get(name, 0) + gap - time.time()
    if wait > 0:
        time.sleep(wait)
    _last[name] = time.time()


def illustrate(visual, w, h, seed, dest, raw_prompt=False):
    """Draw one picture. The result has the shape (w, 0.92*h) on every service."""
    prompt = visual if raw_prompt else f"{visual}. Style: {HOUSE_STYLE}."
    for name, fn in PROVIDERS:
        if name in _dead:
            continue
        extra = 0
        for attempt in range(4):
            _wait_turn(name, extra)
            try:
                fn(prompt, w, h, seed + attempt, dest)
                _fit(dest, w, h, name)
                return name
            except urllib.error.HTTPError as e:
                detail = e.read()[:400]
                log(f"  {name} image HTTP {e.code} {detail[:200]!r}")
                if name == "cloudflare" and (e.code == 429 or b"allocation" in detail or b"4006" in detail):
                    raise PicturesUsedUp()
                if e.code in (401, 403, 404):
                    _dead.add(name)
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


QUOTE_VOICE = {"am_michael": ("bm_daniel", "en-gb"), "bm_george": ("am_onyx", "en-us"), "hm_omega": ("bm_daniel", "en-gb")}
_PRON = None


def pronounce(text):
    """Apply the owner's pronunciation list (config/pronounce.json, edited in the app's Settings)."""
    global _PRON
    if _PRON is None:
        cfg = read_json(ROOT / "config" / "pronounce.json", {}) or {}
        _PRON = [(re.compile(r"\b" + re.escape(w["word"]) + r"\b", re.I), w["say"]) for w in cfg.get("words", [])
                 if str(w.get("word", "")).strip() and str(w.get("say", "")).strip()]
    for rx, say in _PRON:
        text = rx.sub(say, text)
    return text


def speak(text, voice_key, dest, quote_voice=True):
    """Narration in the chosen voice; words inside quotation marks (a historical figure speaking)
    are read by a second, contrasting voice so quotes stand out."""
    voice, lang = VOICES.get(voice_key, VOICES["en-US-male"])
    parts = re.split(r'([\u201c"][^\u201d"]{12,}[\u201d"])', text) if quote_voice else [text]
    chunks = []
    for part in parts:
        if not part.strip():
            continue
        is_quote = part[:1] in '"\u201c' and part[-1:] in '"\u201d'
        v, l = QUOTE_VOICE.get(voice, (voice, lang)) if is_quote else (voice, lang)
        try:
            audio, sr = tts().create(pronounce(part.strip(' "\u201c\u201d') if is_quote else part), voice=v, lang=l, speed=1.0)
        except Exception:  # a missing second voice must never break the video
            audio, sr = tts().create(pronounce(part), voice=voice, lang=lang, speed=1.0)
        if sr != SR:
            raise RuntimeError(f"unexpected sample rate {sr}")
        chunks += [audio, np.zeros(int(0.12 * SR), dtype=np.float32)]
    audio = np.concatenate(chunks + [np.zeros(int(PAUSE * SR), dtype=np.float32)]) if chunks else np.zeros(int(PAUSE * SR), dtype=np.float32)
    sf.write(dest, audio, SR)
    return len(audio) / SR


# ---------------------------------------------------------------- captions
def ass_time(t):
    t = max(0, t)
    return f"{int(t // 3600)}:{int(t % 3600 // 60):02d}:{t % 60:05.2f}"


CAPTION_FONTS = {  # name shown in the app: (file in github.com/google/fonts, size factor, bold, capitals)
    "Anton": ("ofl/anton/Anton-Regular.ttf", 1.0, 0, True),
    "Bebas Neue": ("ofl/bebasneue/BebasNeue-Regular.ttf", 1.15, 0, True),
    "Poppins": ("ofl/poppins/Poppins-Bold.ttf", 0.85, -1, True),
    "Lilita One": ("ofl/lilitaone/LilitaOne-Regular.ttf", 0.95, 0, True),
    "Bangers": ("ofl/bangers/Bangers-Regular.ttf", 1.05, 0, True),
    "Luckiest Guy": ("apache/luckiestguy/LuckiestGuy-Regular.ttf", 0.85, 0, True),
    "Patrick Hand": ("ofl/patrickhand/PatrickHand-Regular.ttf", 1.1, 0, False),
}


def caption_font(name):
    """Download the chosen caption font (all SIL Open Font License or Apache) and return its settings."""
    name = name if name in CAPTION_FONTS else "Anton"
    path, factor, bold, caps = CAPTION_FONTS[name]
    dest = CACHE / "fonts" / path.rsplit("/", 1)[1]
    if not dest.exists():
        try:
            dest.parent.mkdir(parents=True, exist_ok=True)
            download("https://github.com/google/fonts/raw/main/" + path, dest)
        except Exception as e:
            log(f"Caption font {name} unavailable ({e}); using Anton.")
            return caption_font("Anton") if name != "Anton" else ("Anton", 1.0, 0, True)
    return name, factor, bold, caps


def captions(scenes, starts, durs, w, h, vertical, dest, guide_times=(), font_name="Anton"):
    host_margin = int(h * 0.55) if vertical else 0
    fname, factor, bold, caps = caption_font(font_name)
    size = int((96 if vertical else 78) * factor)
    margin = int(h * 0.27) if vertical else 70
    per = 3 if vertical else 7
    lines = [
        "[Script Info]", "ScriptType: v4.00+", f"PlayResX: {w}", f"PlayResY: {h}", "WrapStyle: 0", "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        f"Style: Cap,{fname},{size},&H00FFFFFF,&H00FFFFFF,&H00161616,&H64000000,{bold},0,0,0,100,100,1,0,1,{6 if vertical else 4},2,2,60,60,{margin},1",
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
            if vertical and caps:
                text = text.upper()
            mid = t + d / 2
            on_guide = any(a <= mid < b for a, b in guide_times)  # the guide stands where captions usually go
            mv = host_margin if (on_guide and host_margin) else 0
            lines.append(f"Dialogue: 0,{ass_time(t)},{ass_time(t + d)},Cap,,0,0,{mv},,{text}")
            t += d
    pathlib.Path(dest).write_text("\n".join(lines) + "\n", encoding="utf-8")


# ---------------------------------------------------------------- old scripts
def upgrade_old_script(script):
    """Scripts written before the animation engine: one full picture per scene, no separate cast."""
    cams = {"slow zoom in": "push_in", "slow zoom out": "pull_out", "pan left": "pan_left", "pan right": "pan_right",
            "drift up": "tilt_up", "drift down": "static"}
    places, scenes = [], []
    for i, sc in enumerate(script.get("scenes", [])):
        look = sc.get("visual") or sc.get("narration", "")
        if not (sc.get("same_place_as_previous") and places):
            places.append({"id": f"s{i}", "look": look, "full": True})
        scenes.append({"narration": sc.get("narration", ""), "shots": [{
            "kind": "story", "place": places[-1]["id"], "characters": [],
            "camera": cams.get(str(sc.get("motion", "")).lower(), "push_in"), "effect": "none",
            "time_label": sc.get("date_label", ""), "bubble": sc.get("bubble", ""), "fact": "", "note": "", "title": ""}]})
    return {**script, "cast": [], "places": places, "scenes": scenes, "use_guide": False}


# ---------------------------------------------------------------- pictures for the animation
class Assets:
    """Backgrounds and cut-out characters for one video, kept between attempts for long videos."""

    def __init__(self, job, script, folder, vertical):
        self.job, self.script, self.dir, self.vertical = job, script, folder, vertical
        self.dir.mkdir(parents=True, exist_ok=True)
        self.tag = f"work-{job['id']}-r{job.get('revision', 0)}"
        self.keep = bool(os.environ.get("GITHUB_REPOSITORY"))
        self.new_since_save = 0

    def restore(self):
        if not self.keep:
            return
        r = subprocess.run(["gh", "release", "download", self.tag, "-p", "assets.tar", "-D", str(self.dir), "--clobber"],
                           capture_output=True, text=True)
        if r.returncode == 0:
            subprocess.run(["tar", "-xf", str(self.dir / "assets.tar"), "-C", str(self.dir)], capture_output=True)
            log(f"  picked up {len(list(self.dir.glob('*.png')))} pictures from the last attempt")

    def checkpoint(self, force=False):
        if not self.keep or (self.new_since_save < 8 and not force) or not self.new_since_save:
            return
        self.new_since_save = 0
        pngs = [p.name for p in self.dir.glob("*.png")]
        subprocess.run(["tar", "-cf", str(self.dir / "assets.tar"), "-C", str(self.dir), *pngs], capture_output=True)
        if subprocess.run(["gh", "release", "view", self.tag], capture_output=True).returncode != 0:
            subprocess.run(["gh", "release", "create", self.tag, "--title", "Work in progress", "--notes",
                            "Pictures for a long video that is still being made. Deleted automatically.",
                            "--prerelease", "--latest=false"], capture_output=True)
        subprocess.run(["gh", "release", "upload", self.tag, str(self.dir / "assets.tar"), "--clobber"], capture_output=True)

    def done(self):
        if self.keep:
            subprocess.run(["gh", "release", "delete", self.tag, "--yes", "--cleanup-tag"], capture_output=True)

    def place(self, p, seed):
        dest = self.dir / f"place_{p['id']}.png"
        if dest.exists():
            return dest
        gw, gh = (768, 1456) if self.vertical else (1344, 832)  # a bit taller; the bottom strip is cut off
        if p.get("full"):
            prompt = f"{p['look'][:1400]}. Style: {HOUSE_STYLE}."
        else:
            prompt = (f"{p['look']}. An empty setting with no people and no animals, background art for an animated "
                      f"film, {'tall vertical' if self.vertical else 'wide'} composition with open ground in the lower "
                      f"part of the picture. Style: {HOUSE_STYLE}.")
        raw = self.dir / f"_raw_{p['id']}.png"
        if not illustrate(prompt, gw, gh, seed, raw, raw_prompt=True):
            return None
        raw.replace(dest)
        self.new_since_save += 1
        self.checkpoint()
        return dest

    def sprite(self, c, pose, seed):
        dest = self.dir / f"cast_{c['id']}_{pose}.png"
        if dest.exists():
            return dest
        kind = c.get("kind", "person")
        w, h = (1024, 1024) if kind == "object" else (768, 1216)
        raw = self.dir / f"_raw_{c['id']}_{pose}.png"
        for attempt in range(2):
            if not illustrate(sprite_prompt(c["look"], c["poses"][pose], kind), w, h, seed + attempt * 101, raw, raw_prompt=True):
                return None
            try:
                cut_out_white(raw, dest)
                self.new_since_save += 1
                self.checkpoint()
                return dest
            except Exception as e:
                log(f"  {c['id']} / {pose}: {e}")
            finally:
                raw.unlink(missing_ok=True)
        return None


def _render_one(args):
    """Runs in a separate process: build one shot's layers and animate it."""
    i, shot, RW, RH, n, out, fonts, cache, seed = args
    import animate
    from overlays import host_background, story_overlay
    spec = dict(shot)
    if shot["kind"] == "host":
        spec["bg"] = host_background(RW, RH, shot.get("note"), shot.get("time_label"), cache,
                                     out.with_suffix(".bg.png"), host_left=shot.get("host_left", True))
    elif shot["kind"] == "story" and (shot.get("time_label") or shot.get("bubble")):
        spec["overlay"] = story_overlay(RW, RH, shot.get("time_label"), shot.get("bubble"),
                                        "left" if i % 2 else "right", cache, out.with_suffix(".ov.png"))
    if shot["kind"] == "title":
        spec["subtitle"] = shot.get("time_label", "")
    animate.render_shot(spec, RW, RH, FPS, n, out, fonts, seed)
    return str(out)


MAX_SHOT = 4.0
FOLLOW_CAMS = ["close_left", "pull_out", "close_right", "push_in", "close_center", "pan_left", "close_top", "pan_right"]
FOLLOW_ACTS = ["talk", "nod", "sway", "point", "approach", "turn"]


def split_long(shots, frames):
    """Cut any shot that would last longer than MAX_SHOT seconds into a few shorter ones,
    each with a new camera move and the characters doing something new."""
    per = frames / len(shots) / FPS
    if per <= MAX_SHOT:
        return shots
    pieces = math.ceil(per / 3.2)
    out = []
    for n, sh in enumerate(shots):
        out.append(sh)
        for k in range(1, pieces):
            follow = json.loads(json.dumps(sh))
            follow["camera"] = FOLLOW_CAMS[(n + k) % len(FOLLOW_CAMS)]
            for j, c in enumerate(follow.get("characters", [])):
                if c.get("then_pose"):
                    c["pose"], c["then_pose"] = c["then_pose"], ""
                c["action"] = FOLLOW_ACTS[(n + k + j) % len(FOLLOW_ACTS)]
            for key in ("fact", "title", "time_label", "bubble"):
                follow[key] = ""
            if follow["kind"] == "title":
                follow["kind"] = "story"
            out.append(follow)
    return out


# ---------------------------------------------------------------- assembly
def render(job, script, out_dir):
    vertical = job["format"] == "short"
    W, H = (1080, 1920) if vertical else (1920, 1080)  # final video
    RW, RH = (720, 1280) if vertical else (1280, 720)  # animation is drawn at 720p, then scaled up smoothly
    if not script.get("places"):
        script = upgrade_old_script(script)
    scenes = [s for s in script.get("scenes", []) if str(s.get("narration", "")).strip()]
    if not scenes:
        raise WorkerError("The script has no scenes to turn into a video.")
    seed0 = int(hashlib.sha1(f"{job['id']}-{job.get('revision', 0)}".encode()).hexdigest()[:6], 16)  # new pictures on each redo

    # 1. voice
    log(f"Voice for {len(scenes)} scenes...")
    durs = []
    for i, sc in enumerate(scenes):
        durs.append(max(2.0, speak(sc["narration"], job.get("voice", "en-US-male"), out_dir / f"v{i:03d}.wav", job.get("quote_voice", True))))
    parts = []
    for i, d in enumerate(durs):
        a = sf.read(out_dir / f"v{i:03d}.wav", dtype="float32")[0]
        parts.append(np.concatenate([a, np.zeros(max(0, int(d * SR) - len(a)), dtype=np.float32)]))
        (out_dir / f"v{i:03d}.wav").unlink()
    voice = np.concatenate(parts)
    sf.write(out_dir / "voice.wav", voice, SR)
    total = len(voice) / SR
    starts = np.concatenate([[0], np.cumsum(durs)[:-1]]).tolist()

    # 2. pictures: empty backgrounds, then each character pose on white (cut out afterwards)
    places = {p["id"]: p for p in script.get("places", [])}
    cast = {c["id"]: c for c in script.get("cast", [])}
    assets = Assets(job, script, out_dir / "assets", vertical)
    assets.restore()
    log(f"Pictures: {len(places)} places, {sum(len(c['poses']) for c in cast.values())} character poses...")
    guide_ok = False
    if any(sh["kind"] == "guide" for sc in scenes for sh in sc.get("shots", [])):
        if ensure_host(illustrate, log):
            save(["assets"], "Draw the guide's poses")
        guide_ok = host_pose("talk") is not None
    place_pic, sprite_pic = {}, {}
    order = []  # draw in order of first use, so an early failure is noticed early
    for sc in scenes:
        for sh in sc.get("shots", []):
            if sh.get("place") in places and ("p", sh["place"]) not in order:
                order.append(("p", sh["place"]))
            for c in sh.get("characters", []):
                for pose in (c.get("pose"), c.get("then_pose")):
                    if pose and c["id"] in cast and pose in cast[c["id"]]["poses"] and ("c", c["id"], pose) not in order:
                        order.append(("c", c["id"], pose))
    for item in order:
        if item[0] == "p":
            pid = item[1]
            got = assets.place(places[pid], seed0 + int(hashlib.sha1(pid.encode()).hexdigest()[:5], 16))
            if got:
                place_pic[pid] = got
            log(f"  place {pid}: {'ok' if got else 'failed'}")
        else:
            cid, pose = item[1], item[2]
            got = assets.sprite(cast[cid], pose, seed0 + int(hashlib.sha1(cid.encode()).hexdigest()[:5], 16))  # same seed for every pose keeps the look
            if got:
                sprite_pic[(cid, pose)] = got
            log(f"  {cid} / {pose}: {'ok' if got else 'failed'}")
    assets.checkpoint(force=True)
    wanted = len({i[1] for i in order if i[0] == "p"})
    if wanted and len(place_pic) < max(1, int(wanted * 0.6)):
        raise WorkerError(f"Only {len(place_pic)} of {wanted} backgrounds could be drawn (the free picture service may be "
                          "busy). It will try again within the hour.", transient=True)
    place_ids = list(places)

    def nearest_place(pid):
        if pid in place_pic:
            return place_pic[pid]
        k = place_ids.index(pid) if pid in place_ids else 0
        return place_pic[min(place_pic, key=lambda q: abs(place_ids.index(q) - k))]

    def sprite(cid, pose):
        if cid == "guide":
            return host_pose(pose) if guide_ok else None
        return sprite_pic.get((cid, pose)) or next((v for (c, p), v in sprite_pic.items() if c == cid), None)

    # 3. shot list with exact frame counts, following the narration
    edges = [round(x * FPS) for x in np.cumsum([0] + durs)]
    jobs, guide_times, side = [], [], 0
    for i, sc in enumerate(scenes):
        frames = edges[i + 1] - edges[i]
        shots = [sh for sh in sc.get("shots", []) if sh["kind"] != "guide" or guide_ok] or \
                [{"kind": "story", "place": place_ids[0], "characters": [], "camera": "push_in", "effect": "none"}]
        shots = shots[:max(1, frames // int(FPS * 1.4))]  # every shot stays on screen at least 1.4 s
        shots = split_long(shots, frames)  # never hold one picture longer than about 4 s
        cuts = [round(frames * k / len(shots)) for k in range(len(shots) + 1)]
        for k, sh in enumerate(shots):
            n = cuts[k + 1] - cuts[k]
            t0 = (edges[i] + cuts[k]) / FPS
            chars = []
            for c in sh.get("characters", []):
                a = sprite(c["id"], c["pose"])
                if a is None:
                    continue
                b = sprite(c["id"], c["then_pose"]) if c.get("then_pose") else None
                chars.append({"a": a, "b": b, "action": c.get("action", "stand"), "pos": c.get("position", "center"),
                              "scale": 0.55 if cast.get(c["id"], {}).get("kind") == "object" else 1.0})
            kind = {"guide": "host", "title": "title"}.get(sh["kind"], "story")
            spec = {"kind": kind, "camera": sh.get("camera", "static"), "effect": sh.get("effect", "none"),
                    "chars": chars, "fact": "", "title": sh.get("title", ""),
                    "time_label": sh.get("time_label", ""), "bubble": sh.get("bubble", ""), "note": sh.get("note", "")}
            if kind == "host":
                spec["host_left"] = side % 2 == 0
                side += 1
                spec["camera"] = "static"
                spec["effect"] = "none"
                spec["bg"] = None
                guide_times.append((t0, t0 + n / FPS))
            else:
                spec["bg"] = nearest_place(sh.get("place"))
            jobs.append((len(jobs), spec, RW, RH, n, out_dir / f"shot{len(jobs):04d}.mp4", None, CACHE, seed0 + len(jobs)))

    # 4. music and captions
    log("Music...")
    music = make_music(total + 1, job.get("tone", ""), seed=seed0)
    own = sorted((ROOT / "music").glob("*.mp3")) if (ROOT / "music").exists() else []
    music_path = out_dir / "music.wav"
    if own:
        music_path = random.Random(seed0).choice(own)
        log(f"  using your track {music_path.name}")
    else:
        sf.write(music_path, music, SR)
    font(CACHE, "Anton-Regular.ttf", 20)  # makes sure both fonts are downloaded
    font(CACHE, "PatrickHand-Regular.ttf", 20)
    fonts_dir = CACHE / "fonts"
    fonts = {"display": str(fonts_dir / "Anton-Regular.ttf"), "hand": str(fonts_dir / "PatrickHand-Regular.ttf")}
    captions(scenes, starts, durs, W, H, vertical, out_dir / "captions.ass", guide_times, job.get("captionFont", "Anton"))
    import sfx  # quiet background sounds that follow each scene (fire, crowd, sea...)
    amb = sfx.track(scenes, starts, durs, total, seed=seed0)
    sf.write(out_dir / "sfx.wav", amb, SR)

    # 5. animate every shot, several at once
    workers = max(1, (os.cpu_count() or 2))
    log(f"Animating {len(jobs)} shots on {workers} cores...")
    jobs = [j[:6] + (fonts,) + j[7:] for j in jobs]
    from concurrent.futures import ProcessPoolExecutor
    with ProcessPoolExecutor(workers) as pool:
        clips = []
        for k, path in enumerate(pool.map(_render_one, jobs, chunksize=1)):
            clips.append(pathlib.Path(path))
            if (k + 1) % 50 == 0:
                log(f"  {k + 1} of {len(jobs)} shots done")
    (out_dir / "clips.txt").write_text("".join(f"file '{c.resolve()}'\n" for c in clips))

    # 6. one final pass: scale up, captions, voice and music
    log("Final video...")
    subs = str(out_dir / "captions.ass").replace(":", r"\:")
    graph = (f"[0:v]scale={W}:{H}:flags=lanczos,subtitles='{subs}':fontsdir='{fonts_dir}'[vout];"
             f"[2:a]aloop=loop=-1:size=2e9,atrim=0:{total:.2f},lowpass=f=2400,volume=0.22[m];"
             f"[1:a]asplit=2[v1][vv];"
             f"[m][v1]sidechaincompress=threshold=0.03:ratio=6:attack=30:release=600[md];"
             f"[3:a]atrim=0:{total:.2f}[fx];"
             f"[vv][md][fx]amix=inputs=3:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11[aout]")
    out = out_dir / "video.mp4"
    run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(out_dir / "clips.txt"),
         "-i", str(out_dir / "voice.wav"), "-i", str(music_path), "-i", str(out_dir / "sfx.wav"),
         "-filter_complex", graph, "-map", "[vout]", "-map", "[aout]",
         "-c:v", "libx264", "-preset", os.environ.get("X264_PRESET", "veryfast"), "-crf", "20", "-pix_fmt", "yuv420p",
         "-r", str(FPS), "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "1", "-t", f"{total:.2f}",
         "-movflags", "+faststart", str(out)])
    assets.done()
    if not vertical and job.get("intro", True):  # long videos: branded intro + end screen
        try:
            import branding
            out, lead, added = branding.wrap(out, W, H, CACHE, out_dir)
            starts = [x + lead for x in starts]
            total += added
            job["intro_seconds"] = lead
        except Exception as e:
            log(f"  intro/end screen skipped: {e!r}")
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
    only = os.environ.get("RENDER_FORMAT", "").strip()
    if job and only and job.get("format") != only:
        return False  # the other video maker handles this one
    if job and job.get("status") == "rendering" and stale(job, 380 if job.get("format") == "long" else 180):
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
        if not isinstance(e, PicturesUsedUp):  # waiting for tomorrow's free pictures is not a failure
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
    for path in ordered_jobs():
        job = read_json(path, {})
        if job.get("status") not in ("script_ready", "rendering") or (only and job.get("id") != only) or not_yet(job):
            continue
        if done >= MAX_RENDERS:
            break
        if process(path):
            done += 1
    log(f"Made {done} video(s).")


if __name__ == "__main__":
    main()
