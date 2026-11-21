"""Pinterest pins and Redbubble print files, made from each blog article's pictures. Fully automatic.

Runs every 3 hours (pins.yml).

Pinterest (no API approval needed):
  Pinterest can read a pin list (an RSS feed) and turn each new entry into a pin by itself
  ("Auto-publish" under Settings > Create Pins in bulk). For every published blog article this script
  makes tall 1000x1500 pin pictures (the video's pictures with the story title on them) in app/pins/ and
  adds them to app/pins.xml a few at a time (`per_day`, default 3, one per run), so the board grows
  steadily instead of in bursts. Each pin links to the article on the claimed blog, where the video plays.

Redbubble (no upload robot allowed):
  For every article it also picks the best pictures, enlarges them to print size (4800 px) and uploads
  them to the free GitHub release "prints", with a ready title, tags and description in prints/<id>.json.
  The owner uploads them on redbubble.com from the app's Income tab (Download, Copy, paste).

Settings: config/pins.json and config/prints.json (edited in the app's Income tab).
"""
import datetime
import email.utils
import html
import json
import os
import re
import subprocess
import sys
import urllib.request

from common import ROOT, UA, read_json, save, sync, write_json

BLOG = ROOT / "blog"
IMG = ROOT / "app" / "blog-img"
PIN_DIR = ROOT / "app" / "pins"
FEED = ROOT / "app" / "pins.xml"
PINS = ROOT / "pins"
PRINTS = ROOT / "prints"
CACHE = ROOT / ".cache"
PIN_DEFAULTS = {"enabled": True, "per_day": 3, "per_article": 5}
PRINT_DEFAULTS = {"enabled": False, "per_video": 2}  # Redbubble paused by the owner (2026-11-21); set True to bring it back
FONTS = {  # SIL Open Font License
    "LibreBaskerville-Bold.ttf": "https://github.com/google/fonts/raw/main/ofl/librebaskerville/LibreBaskerville-Bold.ttf",
    "Inter.ttf": "https://github.com/google/fonts/raw/main/ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf",
}
SYSTEM_FONTS = {"LibreBaskerville-Bold.ttf": "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
                "Inter.ttf": "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"}
CREAM = (244, 233, 212)
GOLD = (233, 178, 92)
INK = (18, 16, 22)
PRINT_SIZE = 4800
STYLES = ["Vintage History Art", "Historical Illustration", "History Poster Art", "Classic History Painting"]
GENERIC_TAGS = ["history", "history buff", "history lover gift", "history teacher", "vintage", "historical art",
                "wall art", "illustration", "old world", "antique style"]


def log(*a):
    print(*a, flush=True)


def now():
    return datetime.datetime.now(datetime.timezone.utc)


def iso(t=None):
    return (t or now()).isoformat(timespec="seconds")


def pages_base():
    repo = os.environ.get("GITHUB_REPOSITORY", "rishabh123joshi321-stack/story-studio")
    owner, name = repo.split("/", 1)
    return f"https://{owner.lower()}.github.io/{name}/"


def cfg(name, defaults):
    c = dict(defaults)
    c.update(read_json(ROOT / "config" / name, {}) or {})
    return c


def articles():
    """Blog entries that have pictures, oldest first."""
    out = []
    for p in sorted(BLOG.glob("*.json")):
        if p.name == "status.json":
            continue
        e = read_json(p)
        if e and e.get("job_id") and e.get("article") and e.get("pictures"):
            out.append(e)
    return out


def clean(s):
    return re.sub(r"\s+", " ", re.sub(r"\*\*", "", str(s or ""))).strip()


def short(s, n):
    s = clean(s)
    if len(s) <= n:
        return s
    cut = s[:n].rsplit(" ", 1)[0].rstrip(",;:-")
    return cut + "..."


def font(name, size):
    from PIL import ImageFont
    path = CACHE / "fonts" / name
    if not path.exists() and os.environ.get("GITHUB_REPOSITORY"):
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            req = urllib.request.Request(FONTS[name], headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                path.write_bytes(r.read())
        except Exception as e:
            log(f"Font {name} unavailable ({e}); using a system font.")
    for p in (path, SYSTEM_FONTS[name]):
        try:
            f = ImageFont.truetype(str(p), size)
            if name == "Inter.ttf" and p == path:
                try:
                    f.set_variation_by_axes([14, 600])
                except Exception:
                    pass
            return f
        except OSError:
            continue
    return ImageFont.load_default(size=size)


def wrap(draw, text, fnt, max_w):
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


# ---------------------------------------------------------------- Pinterest
def pin_image(src, title, kicker, site, out):
    """A tall 2:3 pin: the picture at the top over a blurred copy of itself, the title on a dark band."""
    from PIL import Image, ImageDraw, ImageFilter, ImageOps
    W, H = 1000, 1500
    im = Image.open(src).convert("RGB")
    bg = ImageOps.fit(im, (W, H), Image.LANCZOS).filter(ImageFilter.GaussianBlur(28))
    bg = Image.blend(bg, Image.new("RGB", (W, H), INK), 0.55)
    pic_h = min(1040, round(im.height * W / im.width))
    pic = ImageOps.fit(im, (W, pic_h), Image.LANCZOS, centering=(0.5, 0.4))
    bg.paste(pic, (0, 0))
    # soft fade from the picture into the dark band
    fade = Image.new("L", (1, 160))
    for y in range(160):
        fade.putpixel((0, y), int(255 * (y / 159) ** 1.4))
    fade = fade.resize((W, 160))
    band = Image.new("RGB", (W, 160), INK)
    bg.paste(band, (0, pic_h - 160), fade)
    d = ImageDraw.Draw(bg)
    d.rectangle([0, pic_h, W, H], fill=INK)
    y = pic_h + 34
    kf = font("Inter.ttf", 30)
    d.text((60, y), kicker.upper(), font=kf, fill=GOLD)
    y += 56
    size = 64
    while True:
        tf = font("LibreBaskerville-Bold.ttf", size)
        lines = wrap(d, title, tf, W - 120)
        if (len(lines) <= 4 and len(lines) * size * 1.28 <= H - y - 110) or size <= 38:
            break
        size -= 4
    for ln in lines[:5]:
        d.text((60, y), ln, font=tf, fill=CREAM)
        y += round(size * 1.28)
    d.line([(60, H - 92), (160, H - 92)], fill=GOLD, width=3)
    d.text((60, H - 74), f"Read the story and watch the video · {site}", font=font("Inter.ttf", 24), fill=(200, 190, 175))
    out.parent.mkdir(parents=True, exist_ok=True)
    bg.save(out, "JPEG", quality=86, optimize=True, progressive=True)


def make_pins(entries, pc, status):
    queue = read_json(PINS / "queue.json", []) or []
    have = {q["job_id"] for q in queue}
    site = re.sub(r"^https?://|/$", "", status.get("blog_url", "")) or "our history blog"
    made = 0
    for e in entries:
        if e.get("status") != "published" or not e.get("url") or e["job_id"] in have:
            continue
        art, jid = e["article"], e["job_id"]
        caps = art.get("captions") or []
        labels = [clean(x) for x in (art.get("labels") or [])][:5]
        tags = " ".join("#" + re.sub(r"[^A-Za-z0-9]", "", "".join(w[:1].upper() + w[1:] for w in x.split())) for x in labels if x)
        pics = e["pictures"][: int(pc.get("per_article", 5) or 5)]
        for n, p in enumerate(pics):
            src = IMG / jid / p["file"]
            if not src.exists():
                continue
            cap = clean(caps[n]) if n < len(caps) else ""
            name = f"{jid}-{n + 1}.jpg"
            pin_image(src, clean(art["title"]), (labels[0] if labels else "History"), site, PIN_DIR / name)
            title = clean(art["title"]) if n == 0 or not cap else f"{short(e.get('topic') or art['title'], 40)}: {cap}"
            desc = " ".join(x for x in [cap + ("" if not cap or cap[-1] in ".!?" else "."), clean(art.get("meta_description", "")),
                                        "Read the full story and watch the video on the blog.", tags] if x)
            sep = "&" if "?" in e["url"] else "?"
            queue.append({"id": f"{jid}-{n + 1}", "job_id": jid, "image": f"pins/{name}", "title": short(title, 100),
                          "description": short(desc, 480), "link": f"{e['url']}{sep}utm_source=pinterest&utm_medium=pin&utm_content={n + 1}",
                          "added": None})
            made += 1
        have.add(jid)
    if made:
        log(f"Made {made} new pin pictures.")
    return queue, made


def release_pins(queue, pc):
    """Add at most one pin per run to the feed, and at most per_day a day."""
    today = now().date().isoformat()
    added_today = sum(1 for q in queue if str(q.get("added") or "")[:10] == today)
    if added_today >= int(pc.get("per_day", 3) or 3):
        return 0
    nxt = next((q for q in queue if not q.get("added")), None)
    if not nxt:
        return 0
    nxt["added"] = iso()
    log(f"Pin added to the feed: {nxt['title']}")
    return 1


def write_feed(queue, status):
    base = pages_base()
    live = [q for q in queue if q.get("added")][-100:]
    items = []
    for q in live:
        img = base + q["image"]
        size = (ROOT / "app" / q["image"]).stat().st_size if (ROOT / "app" / q["image"]).exists() else 0
        when = email.utils.format_datetime(datetime.datetime.fromisoformat(q["added"]))
        items.append(f"""  <item>
    <title>{html.escape(q['title'])}</title>
    <link>{html.escape(q['link'])}</link>
    <description>{html.escape(q['description'])}</description>
    <guid isPermaLink="false">{html.escape(q['id'])}</guid>
    <pubDate>{when}</pubDate>
    <enclosure url="{html.escape(img)}" length="{size}" type="image/jpeg"/>
    <media:content url="{html.escape(img)}" medium="image" type="image/jpeg" width="1000" height="1500"/>
  </item>""")
    name = html.escape(status.get("blog_name") or "History stories")
    link = html.escape(status.get("blog_url") or base)
    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
<channel>
  <title>{name} pins</title>
  <link>{link}</link>
  <description>New pictures and stories from {name}</description>
  <language>en</language>
{chr(10).join(items)}
</channel>
</rss>
"""
    old = FEED.read_text(encoding="utf-8") if FEED.exists() else ""
    if xml != old:
        FEED.write_text(xml, encoding="utf-8")
        return True
    return False


# ---------------------------------------------------------------- Redbubble
def gh(*args):
    return subprocess.run(["gh", *args], cwd=ROOT, capture_output=True, text=True)


def upscale(src, out):
    """Enlarge to print size in gentle steps, then sharpen a little."""
    from PIL import Image, ImageFilter
    im = Image.open(src).convert("RGB")
    while max(im.size) < PRINT_SIZE:
        f = min(2.0, PRINT_SIZE / max(im.size))
        im = im.resize((round(im.width * f), round(im.height * f)), Image.LANCZOS)
        im = im.filter(ImageFilter.UnsharpMask(radius=2, percent=45, threshold=3))
    im.save(out, "JPEG", quality=92, optimize=True, dpi=(300, 300))


def spread(pics, k):
    if len(pics) <= k:
        return list(range(len(pics)))
    return sorted({round(i * (len(pics) - 1) / max(1, k - 1)) for i in range(k)})


def make_prints(entries, rc, status):
    repo = os.environ.get("GITHUB_REPOSITORY")
    if not repo:
        log("Not on GitHub; skipping print files.")
        return 0
    brand = clean(status.get("blog_name")) or "our history channel"
    made = 0
    for e in entries:
        jid = e["job_id"]
        if (PRINTS / f"{jid}.json").exists():
            continue
        if gh("release", "view", "prints").returncode != 0:
            gh("release", "create", "prints", "--title", "Print files for Redbubble",
               "--notes", "Print-size pictures made by Story Studio. Upload them on redbubble.com from the app's Income tab.")
        art = e["article"]
        caps = art.get("captions") or []
        labels = [clean(x).lower() for x in (art.get("labels") or [])]
        vtags = [clean(x).lower() for x in (e.get("tags") or [])]
        topic = clean(e.get("topic") or art["title"])
        designs = []
        tmp = CACHE / "prints"
        tmp.mkdir(parents=True, exist_ok=True)
        for k, i in enumerate(spread(e["pictures"], int(rc.get("per_video", 2) or 2))):
            p = e["pictures"][i]
            src = IMG / jid / p["file"]
            if not src.exists():
                continue
            name = f"{jid}-print-{k + 1}.jpg"
            upscale(src, tmp / name)
            r = gh("release", "upload", "prints", str(tmp / name), "--clobber")
            if r.returncode != 0:
                log("Upload failed:", r.stderr[:300])
                continue
            cap = clean(caps[i]) if i < len(caps) else ""
            tags = list(dict.fromkeys([t for t in [topic.lower()[:40]] + labels + vtags + GENERIC_TAGS if t and len(t) <= 40]))[:15]
            designs.append({
                "n": k + 1, "file": name,
                "url": f"https://github.com/{repo}/releases/download/prints/{name}",
                "preview": f"blog-img/{jid}/{p['file']}",
                "title": short(f"{short(topic, 38)} | {STYLES[k % len(STYLES)]}", 60),
                "tags": ", ".join(tags),
                "description": short(" ".join(x for x in [cap or f"A scene from the story of {topic}.",
                                                          f"Original illustration from the {brand} history channel and blog.",
                                                          "A great gift for history lovers, students and teachers."] if x), 500),
            })
        if designs:
            write_json(PRINTS / f"{jid}.json", {"job_id": jid, "topic": topic, "created": iso(), "designs": designs})
            made += len(designs)
            log(f"Print files ready for {topic}: {len(designs)}")
    return made


def main():
    sync()
    status = read_json(BLOG / "status.json", {}) or {}
    entries = articles()
    pc, rc = cfg("pins.json", PIN_DEFAULTS), cfg("prints.json", PRINT_DEFAULTS)
    changed_pages = False
    if pc.get("enabled", True):
        queue, made = make_pins(entries, pc, status)
        added = release_pins(queue, pc)
        if made or added:
            write_json(PINS / "queue.json", queue)
        if write_feed(queue, status) or made:
            changed_pages = True
        write_json(PINS / "status.json", {
            "feed_url": pages_base() + "pins.xml", "made": len(queue), "live": sum(1 for q in queue if q.get("added")),
            "waiting": sum(1 for q in queue if not q.get("added")), "per_day": int(pc.get("per_day", 3) or 3),
            "last_added": max([q["added"] for q in queue if q.get("added")] or [""]),
        })
    else:
        log("Pinterest pins are OFF in the app.")
    if rc.get("enabled", False):
        try:
            make_prints(entries, rc, status)
        except Exception as e:
            print("Print files:", repr(e), file=sys.stderr)
    else:
        log("Print files are OFF in the app.")
    save(["pins", "prints", "app/pins", "app/pins.xml"], "Pins and prints update")
    if changed_pages and os.environ.get("GITHUB_REPOSITORY"):
        r = gh("workflow", "run", "pages.yml", "--ref", "main")
        log("Pages refresh:", "started" if r.returncode == 0 else r.stderr.strip()[:200])


if __name__ == "__main__":
    main()
