"""A short branded intro (3 s) and an end screen (10 s) for long videos.

Drawn from scratch: a glowing lantern light and the channel name on deep navy, with a soft whoosh
and chime. The end screen leaves room for YouTube's own end-screen boxes (added in Studio).
"""
import math
import os
import pathlib
import subprocess

import numpy as np
import soundfile as sf
from PIL import Image, ImageDraw, ImageFilter, ImageFont

import sfx
from common import ROOT, read_json

FPS = 30
FONT_URL = "https://github.com/google/fonts/raw/main/ofl/fraunces/Fraunces%5BSOFT,WONK,opsz,wght%5D.ttf"


def channel_name():
    st = read_json(ROOT / "stats" / "latest.json", {}) or {}
    return (st.get("channel") or {}).get("title") or "Story Studio"


def _font(cache, size):
    from render_video import download
    f = cache / "fonts" / "Fraunces.ttf"
    if not f.exists():
        try:
            f.parent.mkdir(parents=True, exist_ok=True)
            download(FONT_URL, f)
        except Exception:
            pass
    for cand in (f, cache / "fonts" / "Anton-Regular.ttf", pathlib.Path("/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf")):
        try:
            font = ImageFont.truetype(str(cand), size)
            try:
                font.set_variation_by_axes([144, 0, 0, 700])  # opsz, soft, wonk, weight (ignored by static fonts)
            except Exception:
                pass
            return font
        except Exception:
            continue
    return ImageFont.load_default(size=size)


def _background(W, H):
    y, x = np.mgrid[0:H, 0:W]
    d = np.sqrt(((x - W / 2) / W) ** 2 + ((y - H * 0.42) / H) ** 2)
    base = np.stack([22 + 20 * (1 - d), 32 + 22 * (1 - d), 43 + 30 * (1 - d)], -1).clip(0, 255)
    return base.astype(np.float32)


_DIST = {}


def _glow(W, H, r, strength):
    if (W, H) not in _DIST:
        y, x = np.mgrid[0:H, 0:W]
        _DIST[(W, H)] = np.sqrt((x - W / 2) ** 2 + (y - H * 0.42) ** 2).astype(np.float32)
    d = _DIST[(W, H)]
    g = np.exp(-(d / max(1, r)) ** 2)[..., None] * strength
    return g * np.array([255, 170, 70], np.float32)


def _frames(kind, W, H, cache, out_dir):
    name = channel_name()
    big = _font(cache, int(H * (0.11 if W > H else 0.065)))
    small = _font(cache, int(H * (0.04 if W > H else 0.026)))
    bg = _background(W, H)
    n = int((3 if kind == "intro" else 10) * FPS)
    for i in range(n):
        t = i / FPS
        if kind == "intro":
            k = min(1, t / 1.2)
            ease = 1 - (1 - k) ** 3
            fade_out = min(1, max(0, (3 - t) / 0.4))
            arr = bg + _glow(W, H, H * (0.12 + 0.18 * ease), 0.55 * ease)
            arr = arr * fade_out
            img = Image.fromarray(arr.clip(0, 255).astype(np.uint8))
            d = ImageDraw.Draw(img)
            a = int(255 * min(1, max(0, (t - 0.5) / 0.8)) * fade_out)
            layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
            dl = ImageDraw.Draw(layer)
            w = dl.textlength(name, font=big)
            dl.text(((W - w) / 2, H * 0.62), name, font=big, fill=(246, 242, 234, a))
            tag = "True stories from history"
            w2 = dl.textlength(tag, font=small)
            dl.text(((W - w2) / 2, H * 0.62 + big.size * 1.25), tag, font=small, fill=(240, 178, 90, int(a * 0.9)))
            img = Image.alpha_composite(img.convert("RGBA"), layer).convert("RGB")
        else:
            pulse = 0.5 + 0.5 * math.sin(t * 1.3)
            fade = min(1, t / 0.6) * min(1, (10 - t) / 0.6)
            arr = (bg + _glow(W, H, H * 0.22, 0.25 + 0.1 * pulse)) * fade
            img = Image.fromarray(arr.clip(0, 255).astype(np.uint8))
            d = ImageDraw.Draw(img)
            for txt, f, y, col in (("Thanks for watching", big, 0.12, (246, 242, 234)), (f"Subscribe to {name} for more true stories", small, 0.12 + 0.14, (240, 178, 90))):
                w = d.textlength(txt, font=f)
                d.text(((W - w) / 2, H * y), txt, font=f, fill=tuple(int(c * fade) for c in col))
        img.save(out_dir / f"{kind}_{i:04d}.png")
    return n


def make(kind, W, H, cache, out_dir):
    """Returns the path of a finished clip encoded like the main video, or None."""
    out_dir.mkdir(parents=True, exist_ok=True)
    n = _frames(kind, W, H, cache, out_dir)
    secs = n / FPS
    if kind == "intro":
        audio = np.zeros(int(secs * sfx.SR), np.float32)
        w = sfx.whoosh(1.0)
        audio[:len(w)] += w
        c = sfx.chime(2.0)
        s0 = int(0.6 * sfx.SR)
        audio[s0:s0 + len(c)] += c[:len(audio) - s0]
    else:
        from music import make_music
        audio = make_music(secs, "Curious and warm", seed=7)[: int(secs * sfx.SR)] * 0.35
        audio *= np.minimum(1, np.linspace(10, 0, len(audio)) / 1.5)
    wav = out_dir / f"{kind}.wav"
    sf.write(wav, audio, sfx.SR)
    out = out_dir / f"{kind}.mp4"
    subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-framerate", str(FPS), "-i", str(out_dir / f"{kind}_%04d.png"),
                    "-i", str(wav), "-c:v", "libx264", "-preset", os.environ.get("X264_PRESET", "veryfast"), "-crf", "20",
                    "-pix_fmt", "yuv420p", "-r", str(FPS), "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "1",
                    "-shortest", "-movflags", "+faststart", str(out)], check=True)
    for f in out_dir.glob(f"{kind}_*.png"):
        f.unlink()
    return out


def wrap(video, W, H, cache, out_dir):
    """Intro + video + end screen. Returns (new_path, intro_seconds, added_seconds)."""
    intro, outro = make("intro", W, H, cache, out_dir / "brand"), make("outro", W, H, cache, out_dir / "brand")
    lst = out_dir / "wrap.txt"
    lst.write_text("".join(f"file '{p.resolve()}'\n" for p in (intro, video, outro)))
    out = out_dir / "video_wrapped.mp4"
    r = subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(lst),
                        "-c", "copy", "-movflags", "+faststart", str(out)], capture_output=True, text=True)
    if r.returncode != 0:
        print("Quick join failed, re-encoding:", r.stderr[-300:], flush=True)
        subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(intro), "-i", str(video), "-i", str(outro),
                        "-filter_complex", "[0:v][0:a][1:v][1:a][2:v][2:a]concat=n=3:v=1:a=1[v][a]", "-map", "[v]", "-map", "[a]",
                        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
                        "-ar", "48000", "-movflags", "+faststart", str(out)], check=True)
    out.replace(video)  # keep the name video.mp4: the app and YouTube upload look for that file
    return video, 3.0, 13.0
