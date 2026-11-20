"""Cut-out animation engine.

Backgrounds and characters are separate pictures, so characters can walk in and
out, run, jump, nod, fall, turn and swap poses mid-action, while moving effects
(fire, smoke, rain, dust, sparks...) and camera moves play on top. Every frame is
drawn with Pillow and streamed into ffmpeg. Free, and runs on an ordinary CPU.
"""
import math
import random
import subprocess

from PIL import Image, ImageDraw, ImageFilter, ImageFont

from common import ACTIONS, CAMERAS, EFFECTS  # noqa: F401  (the writer uses the same lists)


def ease(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


def ease_out_back(t):
    t = max(0.0, min(1.0, t))
    c = 1.70158
    return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2


# ------------------------------------------------------------------ characters
def slot_x(pos, W, count, index):
    if pos in ("left", "center", "right"):
        return {"left": 0.26, "center": 0.5, "right": 0.74}[pos] * W
    return W * (index + 1) / (count + 1)


def action_state(action, t, secs, W, H, home_x, rng_phase):
    """Where a character is at time t (0..1 of the shot): x, y offset, rotation, scale x/y, alpha, use second pose."""
    now = t * secs
    x, dy, rot, sx, sy, alpha, use_b, flip = home_x, 0.0, 0.0, 1.0, 1.0, 1.0, None, False
    breathe = 1 + 0.012 * math.sin(2 * math.pi * now / 2.4 + rng_phase)
    sy *= breathe
    walk_bob = lambda speed: (-0.016 * H * abs(math.sin(math.pi * now * speed)), 2.2 * math.sin(math.pi * now * speed))
    if action == "talk":
        dy = -0.008 * H * abs(math.sin(math.pi * now * 3.2))
        rot = 1.2 * math.sin(now * 2.1)
    elif action == "nod":
        rot = 3.5 * math.sin(2 * math.pi * now * 1.4)
        dy = -0.004 * H * abs(math.sin(2 * math.pi * now * 1.4))
    elif action == "shake_head":
        x += 0.006 * W * math.sin(2 * math.pi * now * 3)
        rot = 1.5 * math.sin(2 * math.pi * now * 3)
    elif action in ("walk_in_left", "walk_in_right"):
        start = -0.25 * W if action == "walk_in_left" else 1.25 * W
        p = ease(t / 0.6)
        x = start + (home_x - start) * p
        if t < 0.6:
            dy, rot = walk_bob(3.4)
    elif action in ("walk_out_left", "walk_out_right"):
        end = -0.3 * W if action == "walk_out_left" else 1.3 * W
        p = ease((t - 0.35) / 0.65)
        x = home_x + (end - home_x) * p
        if t > 0.35:
            dy, rot = walk_bob(3.4)
    elif action == "run_across":
        x = -0.25 * W + 1.5 * W * t
        dy, rot = walk_bob(6.0)
        rot -= 7
    elif action == "sneak":
        x = home_x - 0.12 * W + 0.24 * W * t
        dy, rot = walk_bob(2.0)
        dy *= 0.5
        sy *= 0.94
    elif action in ("jump", "celebrate"):
        hops = [(0.35, 0.65)] if action == "jump" else [(0.1, 0.35), (0.4, 0.65), (0.7, 0.95)]
        for a, b in hops:
            if a - 0.06 <= t < a:
                sy *= 0.9; sx *= 1.06          # crouch
            elif a <= t < b:
                p = (t - a) / (b - a)
                dy = -0.16 * H * 4 * p * (1 - p)
                sy *= 1.06; sx *= 0.96         # stretch
            elif b <= t < b + 0.05:
                sy *= 0.92; sx *= 1.05         # land
        use_b = action == "celebrate" or t > 0.35
    elif action == "tremble":
        x += 0.004 * W * math.sin(now * 55)
        rot = 0.8 * math.sin(now * 40)
    elif action == "fall":
        p = ease((t - 0.35) / 0.35)
        rot = -82 * p
        dy = 0.02 * H * p
        use_b = t > 0.3
    elif action == "appear":
        p = ease_out_back(t / 0.3)
        sx = sy = max(0.01, p)
        alpha = min(1.0, t / 0.15)
    elif action == "approach":
        s = 0.85 + 0.25 * ease(t)
        sx *= s; sy *= s
        dy, rot = walk_bob(2.6)
        dy *= 0.6
    elif action == "retreat":
        s = 1.1 - 0.3 * ease(t)
        sx *= s; sy *= s
        dy, rot = walk_bob(2.6)
        dy *= 0.6
    elif action == "turn":
        flip = t > 0.5
        if 0.44 < t < 0.56:
            sx *= max(0.15, abs(t - 0.5) / 0.06)
    elif action == "strike":
        use_b = t > 0.42
        if 0.42 <= t < 0.55:
            x += 0.05 * W * ease((t - 0.42) / 0.13)
            rot = -6
        elif t >= 0.55:
            x += 0.05 * W * (1 - ease((t - 0.55) / 0.3))
    elif action == "point":
        use_b = t > 0.3
    elif action == "bow":
        rot = -14 * math.sin(math.pi * ease((t - 0.3) / 0.5)) if 0.3 < t < 0.8 else 0
    elif action == "sway":
        rot = 3 * math.sin(2 * math.pi * now * 0.6)
    elif action == "disappear":
        p = ease((t - 0.55) / 0.3)
        sx = sy = max(0.01, 1 - p)
        alpha = 1 - p
    elif action == "fly_across":
        x = -0.25 * W + 1.5 * W * t
        dy = -0.35 * H + 0.03 * H * math.sin(now * 3)
        rot = -4 + 3 * math.sin(now * 2)
    elif action == "drop_in":
        p = min(1.0, t / 0.3)
        dy = -1.1 * H * (1 - p) ** 2
        if 0.3 <= t < 0.38:
            sy *= 0.88; sx *= 1.08
    elif action == "float":
        dy = -0.02 * H - 0.02 * H * math.sin(now * 2)
        rot = 2 * math.sin(now * 1.3)
    elif action == "spin":
        rot = -360 * ease(t) * 2
    elif action == "sail_across":
        x = home_x - 0.25 * W + 0.5 * W * t
        rot = 4 * math.sin(now * 1.6)
        dy = 0.008 * H * math.sin(now * 1.6 + 1)
    if use_b is None:  # a second pose, when given, takes over halfway through the shot
        use_b = t > 0.5
    return x, dy, rot, sx, sy, alpha, use_b, flip


# ------------------------------------------------------------------ effects
class Effects:
    """Moving weather, fire and sparkle effects, drawn straight onto each frame (fast enough for long videos)."""

    def __init__(self, kind, W, H, secs, seed):
        self.kind, self.W, self.H, self.secs = kind, W, H, secs
        r = random.Random(seed)
        n = {"embers": 70, "fire": 90, "smoke": 14, "rain": 220, "snow": 140, "dust": 26, "sparkles": 45,
             "leaves": 26, "birds": 6, "explosion": 30, "water": 40}.get(kind, 0)
        self.p = [(r.random(), r.random(), r.random(), r.random()) for _ in range(n)]
        self.flashes = sorted(r.uniform(0.15, 0.85) for _ in range(2)) if kind == "lightning" else []
        self.glows = []
        if kind in ("fire", "glow", "explosion"):  # a few ready-made glow strengths, picked per frame
            col = (255, 200, 120) if kind == "glow" else (255, 140, 40)
            if kind == "glow":
                mask = Image.radial_gradient("L").resize((W, H)).point(lambda v: 255 - v)
            else:
                mask = Image.linear_gradient("L").resize((W, H))  # dark at top, bright at bottom
            for lvl in range(1, 7):
                self.glows.append((Image.new("RGB", (W, H), col), mask.point(lambda v, l=lvl: int(v * 0.32 * l / 6))))
        self.small = max(1, min(W, H) // 180)  # unit for sizes, about 4 px at 720p

    def shake(self, t):
        now = t * self.secs
        if self.kind in ("shake", "explosion") or (self.kind == "lightning" and any(abs(t - f) < 0.03 for f in self.flashes)):
            if self.kind == "shake":
                amp = 0.012
            elif self.kind == "explosion":
                amp = 0.02 * max(0, 1 - abs(t - 0.4) * 4)
            else:
                amp = 0.008
            return amp * self.W * math.sin(now * 61), amp * self.H * math.cos(now * 47)
        return 0, 0

    def _soft(self, frame, painter, blur):
        """Draw soft shapes (smoke, fog, dust) on a quarter-size layer, blur it, and lay it over the frame."""
        q = 4
        layer = Image.new("RGBA", (self.W // q, self.H // q), (0, 0, 0, 0))
        painter(ImageDraw.Draw(layer), 1 / q)
        layer = layer.filter(ImageFilter.GaussianBlur(max(1, blur // q))).resize((self.W, self.H), Image.BILINEAR)
        frame.paste(layer, (0, 0), layer)

    def draw(self, frame, t):
        k, W, H, now = self.kind, self.W, self.H, t * self.secs
        if k in ("none", "shake", "", None):
            return frame
        u = W / 1080
        if self.glows:
            if k == "explosion":
                strength = max(0, 1 - abs(t - 0.42) * 3)
            else:
                strength = 0.75 + 0.25 * math.sin(now * 13) * math.sin(now * 7.3) if k == "fire" else 0.85
            lvl = int(round(strength * 6))
            if lvl > 0:
                col, mask = self.glows[min(5, lvl - 1)]
                frame.paste(col, (0, 0), mask)
        if k in ("smoke", "explosion"):
            def paint(d, s):
                for (a, b, c, e) in self.p[:14]:
                    life = (now * (0.06 + 0.06 * c) + a) % 1
                    x = (b * W + (life - 0.5) * 0.2 * W * (1 if e > 0.5 else -1)) * s
                    y = H * (0.95 - life * 0.9) * s
                    rr = (0.08 + 0.18 * life) * W * s
                    d.ellipse([x - rr, y - rr * 0.7, x + rr, y + rr * 0.7], fill=(70, 66, 62, int(80 * math.sin(math.pi * life))))
            self._soft(frame, paint, W // 60)
        if k == "dust":
            def paint(d, s):
                for (a, b, c, e) in self.p:
                    life = (now * (0.3 + 0.3 * c) + a) % 1
                    x = (b * W + life * 0.05 * W) * s
                    y = (H * (0.9 + 0.08 * e) - life * 0.06 * H) * s
                    rr = (0.02 + 0.05 * life) * W * s
                    d.ellipse([x - rr, y - rr * 0.6, x + rr, y + rr * 0.6], fill=(170, 140, 100, int(110 * (1 - life))))
            self._soft(frame, paint, W // 140)
        if k == "fog":
            def paint(d, s):
                for i in range(3):
                    x = (((now * 0.03 * (i + 1)) % 1) * W * 1.5 - 0.5 * W) * s
                    y = H * (0.55 + 0.12 * i) * s
                    d.ellipse([x - 0.6 * W * s, y - 0.08 * H * s, x + 0.6 * W * s, y + 0.08 * H * s], fill=(235, 235, 230, 70))
            self._soft(frame, paint, W // 40)
        d = ImageDraw.Draw(frame, "RGBA")
        if k in ("fire", "embers", "explosion"):
            for (a, b, c, e) in self.p:
                life = (now * (0.25 + 0.35 * c) + a) % 1
                x = (b * W + math.sin(now * 2 + e * 9) * 0.03 * W) % W
                y = H * (1.02 - life * 1.1)
                rr = (2 + 5 * c) * (1 - life) * u
                d.ellipse([x - rr, y - rr, x + rr, y + rr], fill=(255, int(150 + 90 * e), 60, int(255 * (1 - life))))
        if k == "rain":
            for (a, b, c, e) in self.p:
                y = ((now * (1.6 + c) + a) % 1) * H * 1.2 - 0.1 * H
                x = (b * W * 1.2 - y * 0.25) % W
                ln = 0.04 * H
                d.line([x, y, x - ln * 0.25, y + ln], fill=(200, 215, 230, 120), width=max(1, W // 900))
        if k == "snow":
            for (a, b, c, e) in self.p:
                y = ((now * (0.08 + 0.1 * c) + a) % 1) * H
                x = (b * W + math.sin(now * (0.8 + c) + e * 6) * 0.03 * W) % W
                rr = (2 + 4 * c) * u
                d.ellipse([x - rr, y - rr, x + rr, y + rr], fill=(255, 255, 255, 210))
        if k == "sparkles":
            for (a, b, c, e) in self.p:
                tw = max(0, math.sin(now * (2 + 3 * c) + a * 6.28))
                x, y, rr = b * W, e * H * 0.8, (3 + 8 * c) * tw * u
                if rr > 0.5:
                    wd = max(1, int(rr / 2))
                    d.line([x - rr * 2, y, x + rr * 2, y], fill=(255, 245, 200, 230), width=wd)
                    d.line([x, y - rr * 2, x, y + rr * 2], fill=(255, 245, 200, 230), width=wd)
        if k == "lightning":
            for f in self.flashes:
                if abs(t - f) < 0.025:
                    d.rectangle([0, 0, W, H], fill=(255, 255, 255, 150))
        if k == "leaves":
            for (a, b, c, e) in self.p:
                y = ((now * (0.07 + 0.08 * c) + a) % 1) * H * 1.1 - 0.05 * H
                x = (b * W + math.sin(now * 1.3 + e * 6) * 0.06 * W) % W
                ang = now * (1 + 2 * c) + e * 6
                rr = (6 + 6 * c) * u
                pts = [(x + rr * math.cos(ang), y + rr * 0.5 * math.sin(ang)), (x - rr * math.cos(ang), y - rr * 0.5 * math.sin(ang))]
                d.line(pts, fill=(196, 110, 40, 220), width=max(2, int(rr * 0.8)))
        if k == "birds":
            for (a, b, c, e) in self.p:
                x = ((now * (0.05 + 0.04 * c) + a) % 1) * W * 1.3 - 0.15 * W
                y = H * (0.1 + 0.25 * b) + math.sin(now * 2 + e * 5) * 0.01 * H
                sz = (10 + 10 * c) * u
                flap = math.sin(now * 9 + e * 6) * sz * 0.6
                d.line([(x - sz, y - flap), (x, y), (x + sz, y - flap)], fill=(40, 40, 45, 230), width=max(2, int(sz / 5)))
        if k == "water":
            for (a, b, c, e) in self.p:
                x = b * W + math.sin(now * (1 + c) + a * 6) * 0.02 * W
                y = H * (0.75 + 0.22 * e)
                w = (0.03 + 0.04 * c) * W
                d.line([x - w, y, x + w, y], fill=(235, 245, 255, int(120 * (0.5 + 0.5 * math.sin(now * 2 + a * 6)))), width=max(1, W // 700))
        if k == "explosion" and 0.38 < t < 0.46:
            d.rectangle([0, 0, W, H], fill=(255, 240, 210, int(200 * (1 - abs(t - 0.42) / 0.04))))
        return frame


# ------------------------------------------------------------------ camera
def camera_box(kind, t, secs, bw, bh, W, H):
    """Which part of the (slightly larger) background is visible at time t."""
    now = t * secs
    base = min(bw / W, bh / H)  # scale where the background exactly covers the frame
    z, cx, cy = 1.0, 0.5, 0.5
    if kind == "push_in":
        z = 1.0 + 0.12 * ease(t)
    elif kind == "pull_out":
        z = 1.12 - 0.12 * ease(t)
    elif kind == "pan_left":
        z, cx = 1.08, 0.58 - 0.16 * ease(t)
    elif kind == "pan_right":
        z, cx = 1.08, 0.42 + 0.16 * ease(t)
    elif kind == "tilt_up":
        z, cy = 1.08, 0.58 - 0.16 * ease(t)
    elif kind == "crash_zoom":
        z = 1.0 + 0.25 * (1 - ease(now / 0.35))
    else:  # static: a barely-there drift so the frame never looks frozen
        z = 1.0 + 0.025 * t
    vw, vh = W * base / z, H * base / z
    x0 = min(max(0, cx * bw - vw / 2), bw - vw)
    y0 = min(max(0, cy * bh - vh / 2), bh - vh)
    return (x0, y0, x0 + vw, y0 + vh)


# ------------------------------------------------------------------ text
def _font(path, size):
    try:
        return ImageFont.truetype(str(path), size)
    except OSError:
        return ImageFont.load_default(size=size)


def make_fact_card(text, fonts, W, H):
    """'Did you know?' card, drawn once per shot."""
    vertical = H > W
    size = int(W * (0.045 if vertical else 0.026))
    head = _font(fonts["display"], int(size * 1.1))
    body = _font(fonts["hand"], size)
    d0 = ImageDraw.Draw(Image.new("RGB", (8, 8)))
    max_w = int(W * (0.78 if vertical else 0.38))
    words, lines, cur = str(text).split(), [], ""
    for w in words:
        test = (cur + " " + w).strip()
        if d0.textlength(test, font=body) <= max_w or not cur:
            cur = test
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    lines = lines[:4]
    pad = size // 2
    cw = max_w + 2 * pad
    ch = int(size * 1.5) + len(lines) * int(size * 1.15) + 2 * pad
    card = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
    cd = ImageDraw.Draw(card)
    cd.rounded_rectangle([0, 0, cw - 1, ch - 1], radius=pad, fill=(250, 243, 226, 242), outline=(29, 34, 40, 255), width=max(3, size // 12))
    cd.text((pad, pad), "DID YOU KNOW?", font=head, fill=(194, 87, 43, 255))
    ty = pad + int(size * 1.5)
    for line in lines:
        cd.text((pad, ty), line, font=body, fill=(29, 34, 40, 255))
        ty += int(size * 1.15)
    return card


def place_fact_card(frame, card, t, W, H):
    """Slides the card up from the bottom with a little overshoot."""
    p = ease_out_back((t - 0.12) / 0.18) if t > 0.12 else 0
    if p <= 0:
        return
    y_final = int(H * (0.27 if H > W else 0.08))
    frame.paste(card, (int(W * 0.05), int(y_final + (1 - p) * H * 0.5)), card)


def title_card(frame, title, subtitle, t, fonts, W, H):
    """Big chapter or date title that punches in over a darkened background."""
    dark = Image.new("RGB", (W, H), (12, 14, 18))
    frame = Image.blend(frame, dark, 0.55)
    p = ease_out_back(t / 0.25)
    size = int(W * (0.11 if H > W else 0.07))
    f = _font(fonts["display"], size)
    sf = _font(fonts["hand"], int(size * 0.45))
    d = ImageDraw.Draw(frame)
    words, lines, cur = str(title).upper().split(), [], ""
    for w in words:
        test = (cur + " " + w).strip()
        if d.textlength(test, font=f) <= W * 0.86 or not cur:
            cur = test
        else:
            lines.append(cur); cur = w
    if cur:
        lines.append(cur)
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    y = H / 2 - len(lines) * size * 0.55
    for l in lines[:3]:
        lw = ld.textlength(l, font=f)
        ld.text(((W - lw) / 2, y), l, font=f, fill=(250, 240, 220, 255), stroke_width=max(3, size // 25), stroke_fill=(10, 10, 10, 255))
        y += size * 1.08
    if subtitle:
        sw = ld.textlength(subtitle, font=sf)
        ld.text(((W - sw) / 2, y + size * 0.15), subtitle, font=sf, fill=(245, 196, 82, 255))
    s = max(0.05, p)
    if abs(s - 1) > 0.01:
        lw2, lh2 = int(W * s), int(H * s)
        layer = layer.resize((lw2, lh2), Image.BILINEAR)
        canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        canvas.paste(layer, ((W - lw2) // 2, (H - lh2) // 2), layer)
        layer = canvas
    return Image.alpha_composite(frame.convert("RGBA"), layer).convert("RGB")


# ------------------------------------------------------------------ one shot
def _img(x, mode=None):
    if x is None:
        return None
    im = x if isinstance(x, Image.Image) else Image.open(x)
    return im.convert(mode) if mode else im


def render_shot(shot, W, H, fps, n, out_path, fonts, seed=0):
    """Draw one shot frame by frame and encode it.

    shot: bg (picture or path), camera, chars [{a, b, action, pos, scale}] (sprites or paths with transparency),
    effect, overlay (transparent layer or path), fact, title, subtitle, kind ('story' | 'host' | 'title'), host_left.
    """
    secs = n / fps
    proc = subprocess.Popen(
        ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
         "-s", f"{W}x{H}", "-r", str(fps), "-i", "-", "-c:v", "libx264", "-preset", "veryfast", "-crf", "17",
         "-pix_fmt", "yuv420p", "-threads", "1", "-an", str(out_path)], stdin=subprocess.PIPE)
    bg = _img(shot["bg"], "RGB")
    cover = max(W * 1.14 / bg.width, H * 1.14 / bg.height)  # a little larger than the frame, so the camera can move
    bg = bg.resize((int(bg.width * cover), int(bg.height * cover)), Image.LANCZOS)
    kind = shot.get("kind", "story")
    fx = Effects(shot.get("effect") or "none", W, H, secs, seed)
    overlay = _img(shot.get("overlay"), "RGBA")
    card = make_fact_card(shot["fact"], fonts, W, H) if shot.get("fact") else None
    vertical = H > W
    target_h = H * ((0.5 if vertical else 0.8) if kind == "host" else (0.46 if vertical else 0.72))
    chars = [c for c in (shot.get("chars") or []) if c.get("a") is not None]
    prepared = []
    for i, c in enumerate(chars):
        sprites = []
        for key in ("a", "b"):
            im = _img(c.get(key), "RGBA")
            if im is not None:
                s = target_h * float(c.get("scale", 1.0)) / im.height
                im = im.resize((max(1, int(im.width * s)), max(1, int(im.height * s))), Image.LANCZOS)
            sprites.append(im)
        home = slot_x(c.get("pos", "center"), W, len(chars), i)
        if kind == "host":
            home = W * 0.5 if vertical else (W * 0.25 if shot.get("host_left", True) else W * 0.75)
        prepared.append((sprites[0], sprites[1], c.get("action", "stand"), home, random.Random(seed + i).random() * 6, {}))
    ground = H * (0.95 if kind == "host" else 0.965)
    try:
        for f in range(n):
            t = f / max(1, n - 1)
            ox, oy = fx.shake(t)
            if shot.get("camera") == "shake":
                ox += 0.008 * W * math.sin(t * secs * 50)
                oy += 0.006 * H * math.cos(t * secs * 43)
            x0, y0, x1, y1 = camera_box(shot.get("camera", "static"), t, secs, bg.width, bg.height, W, H)
            k = (x1 - x0) / W  # background pixels per frame pixel
            dx = max(-x0, min(bg.width - x1, ox * k))
            dy_ = max(-y0, min(bg.height - y1, oy * k))
            frame = bg.resize((W, H), Image.BILINEAR, box=(x0 + dx, y0 + dy_, x1 + dx, y1 + dy_))
            for a, b, action, home, phase, cache in prepared:
                x, dy, rot, sx, sy, alpha, use_b, flip = action_state(action, t, secs, W, H, home, phase)
                # round the changes a little so repeated looks are drawn once and reused
                key = (use_b and b is not None, flip, round(sx / 0.004), round(sy / 0.004), round(rot * 2), round(alpha * 20))
                spr = cache.get(key)
                if spr is None:
                    spr = b if key[0] else a
                    if flip:
                        spr = spr.transpose(Image.FLIP_LEFT_RIGHT)
                    if abs(sx - 1) > 0.003 or abs(sy - 1) > 0.003:
                        spr = spr.resize((max(1, int(spr.width * sx)), max(1, int(spr.height * sy))), Image.BILINEAR)
                    if abs(rot) > 0.4:
                        spr = spr.rotate(rot, resample=Image.BILINEAR, expand=True)
                    if alpha < 0.98:
                        spr = spr.copy()
                        spr.putalpha(spr.getchannel("A").point(lambda v, a_=alpha: int(v * a_)))
                    if len(cache) > 400:
                        cache.clear()
                    cache[key] = spr
                frame.paste(spr, (int(x - spr.width / 2 - ox), int(ground + dy - spr.height - oy)), spr)
            frame = fx.draw(frame, t)
            if overlay is not None and t > 0.06:
                frame.paste(overlay, (0, 0), overlay)
            if card is not None:
                place_fact_card(frame, card, t, W, H)
            if kind == "title":
                frame = title_card(frame, shot.get("title", ""), shot.get("subtitle", ""), t, fonts, W, H)
            proc.stdin.write(frame.tobytes())
    finally:
        proc.stdin.close()
        proc.wait()
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg could not encode {out_path}")
    return out_path
