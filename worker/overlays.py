"""On-screen extras drawn with Pillow: year labels, speech bubbles, handwritten notes,
the plain background for guide scenes, and the guide character's poses."""
import pathlib
import textwrap

from PIL import Image, ImageDraw, ImageFilter, ImageFont

from common import HOST, ROOT

FONTS = {  # all SIL Open Font License
    "Anton-Regular.ttf": "https://github.com/google/fonts/raw/main/ofl/anton/Anton-Regular.ttf",
    "PatrickHand-Regular.ttf": "https://github.com/google/fonts/raw/main/ofl/patrickhand/PatrickHand-Regular.ttf",
}
INK = (29, 34, 40)
PAPER = (236, 229, 214)
HOST_DIR = ROOT / "assets" / "host"


def font(cache, name, size):
    path = pathlib.Path(cache) / "fonts" / name
    if not path.exists():
        try:
            import render_video as rv
            path.parent.mkdir(parents=True, exist_ok=True)
            rv.download(FONTS[name], path)
        except Exception as e:
            print(f"Font {name} unavailable ({e}); using the default.", flush=True)
    try:
        return ImageFont.truetype(str(path), size)
    except OSError:
        return ImageFont.load_default(size=size)


def _wrap(draw, text, fnt, max_w):
    words, lines, cur = text.split(), [], ""
    for w in words:
        test = (cur + " " + w).strip()
        if draw.textlength(test, font=fnt) <= max_w or not cur:
            cur = test
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def date_tag(draw, W, H, text, cache):
    size = int(H * (0.036 if H > W else 0.05))
    f = font(cache, "PatrickHand-Regular.ttf", size)
    pad = size // 3
    x, y = int(W * 0.035), int(H * (0.05 if H > W else 0.06))
    w = draw.textlength(text, font=f)
    draw.rounded_rectangle([x, y, x + w + 2 * pad, y + size + pad], radius=pad, fill=(29, 43, 58, 235))
    draw.text((x + pad, y + pad // 3), text, font=f, fill=(250, 240, 220, 255))


def bubble(draw, W, H, text, side, cache):
    """A white comic speech bubble with a tail pointing down toward the picture."""
    vertical = H > W
    size = int(W * (0.06 if vertical else 0.034))
    f = font(cache, "PatrickHand-Regular.ttf", size)
    max_w = int(W * (0.6 if vertical else 0.32))
    lines = _wrap(draw, text, f, max_w)[:3]
    tw = max(draw.textlength(l, font=f) for l in lines)
    th = len(lines) * int(size * 1.1)
    pad = int(size * 0.55)
    bw, bh = tw + 2 * pad, th + 2 * pad
    x = int(W * 0.07) if side == "left" else int(W * 0.93 - bw)
    y = int(H * (0.16 if vertical else 0.12))
    box = [x, y, x + bw, y + bh]
    tail_x = x + bw * (0.3 if side == "left" else 0.7)
    tail = [(tail_x - size * 0.4, y + bh - 2), (tail_x + size * 0.4, y + bh - 2), (tail_x + (size if side == "left" else -size) * 0.6, y + bh + size * 0.9)]
    draw.rounded_rectangle([b + 4 for b in box], radius=pad, fill=(0, 0, 0, 70))  # soft shadow
    draw.rounded_rectangle(box, radius=pad, fill=(255, 255, 255, 255), outline=INK + (255,), width=max(3, size // 14))
    draw.polygon(tail, fill=(255, 255, 255, 255), outline=INK + (255,))
    draw.line([tail[0], tail[2], tail[1]], fill=INK + (255,), width=max(3, size // 14))
    draw.rectangle([tail[0][0] + 3, y + bh - 6, tail[1][0] - 3, y + bh + 1], fill=(255, 255, 255, 255))
    ty = y + pad - size * 0.08
    for l in lines:
        lw = draw.textlength(l, font=f)
        draw.text((x + (bw - lw) / 2, ty), l, font=f, fill=INK + (255,))
        ty += int(size * 1.1)


def story_overlay(W, H, date_label, bubble_text, side, cache, dest):
    """Transparent layer placed over a story picture. Returns None when there is nothing to show."""
    if not date_label and not bubble_text:
        return None
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if date_label:
        date_tag(d, W, H, str(date_label)[:16], cache)
    if bubble_text:
        bubble(d, W, H, " ".join(str(bubble_text).split()[:8]), side, cache)
    im.save(dest)
    return dest


def host_background(W, H, note, date_label, cache, dest, host_left=True):
    """Plain paper background with an optional handwritten note, for guide scenes."""
    im = Image.new("RGB", (W, H), PAPER)
    # gentle paper grain and vignette
    grain = Image.effect_noise((W // 4, H // 4), 18).resize((W, H)).convert("L")
    im = Image.blend(im, Image.merge("RGB", [grain] * 3), 0.06)
    vig = Image.new("L", (W, H), 0)
    ImageDraw.Draw(vig).ellipse([-W * 0.25, -H * 0.25, W * 1.25, H * 1.25], fill=255)
    vig = vig.filter(ImageFilter.GaussianBlur(min(W, H) // 6))
    im = Image.composite(im, Image.new("RGB", (W, H), (205, 196, 178)), vig)
    d = ImageDraw.Draw(im, "RGBA")
    if date_label:
        date_tag(d, W, H, str(date_label)[:16], cache)
    if note:
        vertical = H > W
        size = int(W * (0.075 if vertical else 0.045))
        f = font(cache, "PatrickHand-Regular.ttf", size)
        max_w = int(W * (0.84 if vertical else 0.46))
        lines = _wrap(d, " ".join(str(note).split()[:10]), f, max_w)[:3]
        x0 = W * 0.08 if (vertical or not host_left) else W * 0.48
        y = H * (0.14 if vertical else 0.24)
        for l in lines:
            lw = d.textlength(l, font=f)
            x = (W - lw) / 2 if vertical else x0
            d.text((x, y), l, font=f, fill=INK)
            y += size * 1.15
    im.save(dest)
    return dest


# ------------------------------------------------------------ the guide character
def cut_out_white(src, dest):
    """Remove the plain white background around a cartoon figure (flood fill from the edges)."""
    im = Image.open(src).convert("RGB")
    im = im.crop((0, 0, im.width, int(im.height * 0.92)))  # drop the free service's mark
    marker = (255, 0, 255)
    w, h = im.size
    seeds = [(x, 0) for x in range(0, w, 16)] + [(x, h - 1) for x in range(0, w, 16)] + \
            [(0, y) for y in range(0, h, 16)] + [(w - 1, y) for y in range(0, h, 16)]
    for pt in seeds:
        r, g, b = im.getpixel(pt)
        if r > 215 and g > 215 and b > 215:
            ImageDraw.floodfill(im, pt, marker, thresh=48)
    px = im.load()
    alpha = Image.new("L", im.size, 255)
    ap = alpha.load()
    for yy in range(h):
        for xx in range(w):
            if px[xx, yy] == marker:
                ap[xx, yy] = 0
    alpha = alpha.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.8))  # trim the white fringe
    out = im.convert("RGBA")
    out.putalpha(alpha)
    bbox = alpha.point(lambda v: 255 if v > 40 else 0).getbbox()
    if not bbox or (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]) < 0.05 * w * h:
        raise RuntimeError("could not separate the character from the background")
    out.crop(bbox).save(dest)
    return dest


def ensure_host(illustrate, log=print):
    """Draw any missing guide poses once; they are saved in assets/host/ and reused for every video."""
    HOST_DIR.mkdir(parents=True, exist_ok=True)
    made = []
    for pose, desc in HOST["poses"].items():
        dest = HOST_DIR / f"{pose}.png"
        if dest.exists():
            continue
        raw = HOST_DIR / f"_{pose}_raw.png"
        prompt = (f"{HOST['look']}, {desc}, full body from head to boots, centered, isolated on a plain pure white "
                  f"background, cartoon character design sheet, no shadow, no scenery, no text")
        ok = illustrate(prompt, 768, 1152, 42424, raw, raw_prompt=True)
        try:
            if ok:
                cut_out_white(raw, dest)
                made.append(pose)
                log(f"  guide pose '{pose}' drawn")
        except Exception as e:
            log(f"  guide pose '{pose}' failed: {e}")
        finally:
            raw.unlink(missing_ok=True)
    return made


def host_pose(name):
    p = HOST_DIR / f"{name}.png"
    if p.exists():
        return p
    have = sorted(HOST_DIR.glob("[!_]*.png")) if HOST_DIR.exists() else []
    return have[hash(name) % len(have)] if have else None
