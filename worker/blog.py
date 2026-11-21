"""Turn each long video into a full blog article and publish it on the owner's free Blogger blog.

Runs every hour (blog.yml). Fully automatic, no approval step:
  1. Write: for each finished long video (not Shorts, not clips) without an article yet, Gemini writes
     an original 1,200 to 1,800 word article from the researched script plus the Wikipedia sources:
     key facts, a timeline, who's who, myths vs facts, why it matters, FAQ and further reading.
     The pictures kept from the video go to app/blog-img/<id>/ (served free by GitHub Pages).
     Saved as blog/<id>.json with status "written".
  2. Publish: once the video is Public on YouTube (so the embedded player works), the article is posted
     to Blogger through the Blogger API, at most `per_day` articles a day (default 1) so the blog grows
     steadily. If the video was posted but is still not found Public after 3 days, the article goes out
     without the player. If the video was deleted from the app, its unpublished article is dropped.
Settings live in config/blog.json (edited in the app's Income tab). blog/status.json tells the app
whether the blog is connected. Standard library only.
"""
import datetime
import difflib
import html
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from common import ROOT, UA, WorkerError, gemini_json, read_json, research, save, sync, write_json

BLOG = ROOT / "blog"
IMG = ROOT / "app" / "blog-img"
DONE_STATES = ("ready", "approved", "uploading", "scheduled", "uploaded", "post_yourself", "posted")
POSTED_STATES = ("uploaded", "posted")
BLOGGER = "https://www.googleapis.com/blogger/v3/"
DEFAULTS = {"enabled": True, "per_day": 1, "amazon_tag": "", "amazon_store": "amazon.com", "blog_id": ""}

SYSTEM = """You are a careful history writer for a reader-friendly history blog with a global audience.
Write original, engaging, accurate articles in clear, simple English (no jargon, short paragraphs).
Use only facts supported by the script and sources you are given; never invent quotes, numbers or books.
Where historians disagree or sources are uncertain, say so. No clickbait, no emojis, no ALL CAPS.
Answer only with JSON in the exact shape requested."""


def log(*a):
    print(*a, flush=True)


def now():
    return datetime.datetime.now(datetime.timezone.utc)


def iso(t=None):
    return (t or now()).isoformat(timespec="seconds")


def parse_time(s):
    try:
        return datetime.datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return None


def config():
    cfg = dict(DEFAULTS)
    cfg.update(read_json(ROOT / "config" / "blog.json", {}) or {})
    return cfg


def pages_base():
    repo = os.environ.get("GITHUB_REPOSITORY", "rishabh123joshi321-stack/story-studio")
    owner, name = repo.split("/", 1)
    return f"https://{owner.lower()}.github.io/{name}/"


# ---------------------------------------------------------------- writing
def wanted(job):
    return (job.get("format") == "long" and not job.get("parent_id") and job.get("status") in DONE_STATES
            and not (BLOG / f"{job['id']}.json").exists())


def fetch_pictures(job):
    """Copy the pictures kept from the video (or at least the thumbnail) into the Pages folder."""
    folder = IMG / job["id"]
    folder.mkdir(parents=True, exist_ok=True)
    tag = f"video-{job['id']}"
    info = []
    if os.environ.get("GITHUB_REPOSITORY"):
        for pattern in ("blog-*.jpg", "blog-stills.json"):
            subprocess.run(["gh", "release", "download", tag, "-p", pattern, "-D", str(folder), "--clobber"], capture_output=True)
        stills = folder / "blog-stills.json"
        if stills.exists():
            info = read_json(stills, []) or []
            stills.unlink()
        if not info:  # older videos: fall back to the thumbnail
            subprocess.run(["gh", "release", "download", tag, "-p", "thumbnail.jpg", "-D", str(folder), "--clobber"], capture_output=True)
            if (folder / "thumbnail.jpg").exists():
                info = [{"file": "thumbnail.jpg", "chapter": 0, "shows": ""}]
    info = [i for i in info if (folder / i["file"]).exists()]
    if not info and not any(folder.iterdir()):
        folder.rmdir()
    return info


def write_article(job, script, pkg, pictures):
    chapters = script.get("chapters") or []
    narration = "\n".join(str(s.get("narration", "")) for s in script.get("scenes", []))
    sources = script.get("sources") or []
    pages = research(job["topic"], job.get("theme", ""), max_pages=3)
    ref = "\n\n".join(f"### {p['title']} ({p['url']})\n{p['text'][:9000]}" for p in pages)
    for p in pages:
        if p["url"] not in [s.get("url") for s in sources]:
            sources.append({"title": p["title"], "url": p["url"]})
    pics = "\n".join(f"{n + 1}. {p.get('shows', '')[:300] or 'the video thumbnail'}" for n, p in enumerate(pictures))
    prompt = f"""Write a blog article that goes with our YouTube video, for people who search Google about this topic.
It must stand on its own and give readers MORE than the video: context, dates, people, myths, and answers to
common questions, so it deserves to rank. Do not copy the narration; rewrite it as an article.

Topic: {job['topic']}
Angle: {job.get('theme', '')}
Video title: {pkg.get('title', '')}
Video chapters: {', '.join(c.get('title', '') for c in chapters)}

Video narration (researched and fact-checked):
{narration[:30000]}

Reference sources:
{ref[:28000]}

Pictures that will appear in the article, in order:
{pics or '(none)'}

Return JSON:
{{
  "title": "search-friendly article title under 65 characters, main keyword early, not identical to the video title",
  "meta_description": "one sentence under 155 characters for Google results",
  "labels": ["3 to 5 short topic labels, e.g. World War II, Spies"],
  "intro": ["2 short paragraphs that hook the reader and include the main search phrase"],
  "key_facts": [{{"label": "When", "value": "..."}}, {{"label": "Where", "value": "..."}}, {{"label": "Who", "value": "..."}}, {{"label": "Outcome", "value": "..."}}],
  "sections": [{{"heading": "clear H2 heading", "paragraphs": ["3 to 5 paragraphs of 2 to 4 sentences"]}}],
  "timeline": [{{"date": "exact date or year", "event": "one sentence"}}],
  "people": [{{"name": "...", "role": "one sentence on who they were and what they did here"}}],
  "myths": [{{"myth": "a common misconception", "truth": "what the sources actually say"}}],
  "why_it_matters": ["1 to 2 paragraphs on why this still matters today"],
  "faq": [{{"q": "a question people really search for", "a": "a 2 to 4 sentence answer"}}],
  "books": [{{"title": "exact title of a real, well-known book on this topic", "author": "author's name", "why": "one sentence on why it is worth reading"}}],
  "captions": ["one short caption per picture, in the same order, describing what it shows in the story"]
}}
Rules: 5 to 7 sections that follow the story in order; 6 to 10 timeline entries; 3 to 6 people; 2 to 4 myths
(only real, commonly repeated ones; leave the list empty if there are none); 4 to 5 FAQ entries; 2 to 3 books
(leave the list empty if you are not sure a book exists). Total length 1,200 to 1,800 words. You may use
**bold** for a few key terms. No quotes that are not in the sources."""
    art = gemini_json(prompt, SYSTEM, temperature=0.6)
    if not isinstance(art, dict):
        raise WorkerError("The AI returned an unusable article.", transient=True)
    sections = [s for s in art.get("sections", []) if isinstance(s, dict) and s.get("heading") and s.get("paragraphs")]
    words = sum(len(str(x).split()) for s in sections for x in s["paragraphs"]) + \
        sum(len(str(x).split()) for x in (art.get("intro") or []) + (art.get("why_it_matters") or [])) + \
        sum(len(str(f.get("a", "")).split()) for f in art.get("faq") or [] if isinstance(f, dict))
    if len(sections) < 4 or words < 900 or not art.get("title"):
        raise WorkerError(f"The article came out too short ({words} words, {len(sections)} sections).", transient=True)
    art["sections"] = sections
    art["word_count"] = words
    art["sources"] = sources[:8]
    return art


def write_phase(cfg):
    """Write at most one new article per run (each takes one free Gemini request)."""
    for path in sorted((ROOT / "jobs").glob("*.json")):
        job = read_json(path)
        if not job or not wanted(job):
            continue
        script = read_json(ROOT / "scripts" / f"{job['id']}.json")
        pkg = read_json(ROOT / "packages" / f"{job['id']}.json")
        if not script or not pkg:
            continue
        log(f"Writing article for {job['id']}: {job['topic']}")
        state = read_json(BLOG / f".attempts-{job['id']}.json", {}) or {}
        try:
            pictures = fetch_pictures(job)
            art = write_article(job, script, pkg, pictures)
            write_json(BLOG / f"{job['id']}.json", {
                "job_id": job["id"], "status": "written", "created": iso(), "topic": job["topic"],
                "video_title": pkg.get("title", ""), "series": job.get("series", ""), "tags": pkg.get("tags", [])[:8],
                "pictures": [{"file": p["file"], "chapter": p.get("chapter", 0)} for p in pictures],
                "article": art,
            })
            (BLOG / f".attempts-{job['id']}.json").unlink(missing_ok=True)
            save(["blog", "app/blog-img"], f"Blog article written: {job['topic'][:60]}")
            if pictures:
                deploy_pages()
            log(f"  done: {art['title']} ({art['word_count']} words)")
        except Exception as e:
            print(repr(e), file=sys.stderr)
            state["attempts"] = state.get("attempts", 0) + 1
            state["error"] = str(e)[:300]
            if state["attempts"] >= 4:  # give up quietly on this one; the video itself is unaffected
                write_json(BLOG / f"{job['id']}.json", {"job_id": job["id"], "status": "skipped", "created": iso(),
                                                        "topic": job["topic"], "error": state["error"]})
                (BLOG / f".attempts-{job['id']}.json").unlink(missing_ok=True)
            else:
                write_json(BLOG / f".attempts-{job['id']}.json", state)
            save(["blog"], f"Blog article update: {job['topic'][:60]}")
        return  # one per run


def deploy_pages():
    """Pushes made by the robot do not start the Pages job by themselves, so start it."""
    if os.environ.get("GITHUB_REPOSITORY"):
        r = subprocess.run(["gh", "workflow", "run", "pages.yml", "--ref", "main"], capture_output=True, text=True)
        log("Pages refresh:", "started" if r.returncode == 0 else r.stderr.strip()[:200])


# ---------------------------------------------------------------- HTML
def text(s):
    """Plain text from the AI, made safe, with **bold** kept."""
    out = html.escape(str(s).strip())
    return re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", out)


def amazon_link(cfg, book):
    tag = str(cfg.get("amazon_tag", "")).strip()
    if not tag:
        return None
    store = str(cfg.get("amazon_store", "amazon.com")).strip() or "amazon.com"
    q = urllib.parse.urlencode({"k": f"{book.get('title', '')} {book.get('author', '')}".strip(), "tag": tag})
    return f"https://www.{store}/s?{q}"


def build_html(entry, cfg, video_id, others):
    art, jid = entry["article"], entry["job_id"]
    base = pages_base() + f"blog-img/{jid}/"
    pics = entry.get("pictures") or []
    caps = art.get("captions") or []
    P = lambda paras: "".join(f"<p>{text(p)}</p>" for p in paras if str(p).strip())

    def figure(i):
        cap = text(caps[i]) if i < len(caps) and caps[i] else ""
        alt = html.escape(re.sub(r"\*\*", "", str(caps[i])) if i < len(caps) else art["title"])
        return (f'<figure style="margin:24px 0;text-align:center"><img src="{base}{pics[i]["file"]}" alt="{alt}" loading="lazy" '
                f'style="max-width:100%;height:auto;border-radius:8px"/>'
                + (f'<figcaption style="font-size:0.9em;opacity:0.75;margin-top:6px">{cap}</figcaption>' if cap else "") + "</figure>")

    out = [P(art.get("intro") or [])]
    if pics:
        out.append(figure(0))
    facts = [f for f in art.get("key_facts") or [] if isinstance(f, dict) and f.get("value")]
    if facts:
        rows = "".join(f'<tr><th style="text-align:left;padding:6px 12px 6px 0;vertical-align:top">{text(f.get("label", ""))}</th>'
                       f'<td style="padding:6px 0">{text(f["value"])}</td></tr>' for f in facts)
        out.append(f'<div style="border:1px solid rgba(128,128,128,.35);border-radius:8px;padding:12px 16px;margin:20px 0">'
                   f'<h3 style="margin-top:0">Key facts</h3><table style="border-collapse:collapse;width:100%">{rows}</table></div>')
    if video_id:
        out.append('<h2>Watch the story</h2><div style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden;margin:16px 0">'
                   f'<iframe src="https://www.youtube.com/embed/{html.escape(video_id)}" title="{html.escape(entry.get("video_title", ""))}" '
                   'style="position:absolute;top:0;left:0;width:100%;height:100%;border:0" loading="lazy" '
                   'allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe></div>')
    secs = art["sections"]
    rest = list(range(1, len(pics)))
    slots = {}  # spread the remaining pictures evenly after the sections
    for k, i in enumerate(rest):
        slots.setdefault(min(len(secs) - 1, round((k + 0.5) * len(secs) / max(1, len(rest)))), []).append(i)
    for n, s in enumerate(secs):
        out.append(f"<h2>{text(s['heading'])}</h2>{P(s['paragraphs'])}")
        out.extend(figure(i) for i in slots.get(n, []))
    tl = [t for t in art.get("timeline") or [] if isinstance(t, dict) and t.get("event")]
    if tl:
        out.append("<h2>Timeline</h2><ul>" + "".join(f"<li><strong>{text(t.get('date', ''))}</strong>: {text(t['event'])}</li>" for t in tl) + "</ul>")
    ppl = [p for p in art.get("people") or [] if isinstance(p, dict) and p.get("name")]
    if ppl:
        out.append("<h2>Who's who</h2><ul>" + "".join(f"<li><strong>{text(p['name'])}</strong>: {text(p.get('role', ''))}</li>" for p in ppl) + "</ul>")
    myths = [m for m in art.get("myths") or [] if isinstance(m, dict) and m.get("myth") and m.get("truth")]
    if myths:
        out.append("<h2>Myths and facts</h2>" + "".join(f"<p><strong>Myth:</strong> {text(m['myth'])}<br/><strong>Fact:</strong> {text(m['truth'])}</p>" for m in myths))
    if art.get("why_it_matters"):
        out.append("<h2>Why it still matters</h2>" + P(art["why_it_matters"]))
    faq = [f for f in art.get("faq") or [] if isinstance(f, dict) and f.get("q") and f.get("a")]
    if faq:
        out.append("<h2>Frequently asked questions</h2>" + "".join(f"<h3>{text(f['q'])}</h3><p>{text(f['a'])}</p>" for f in faq))
    books = [b for b in art.get("books") or [] if isinstance(b, dict) and b.get("title")]
    own = affiliate_extras(entry)
    if books or own:
        items, paid = [], bool(own)
        for b in books:
            name = f"<em>{text(b['title'])}</em>" + (f" by {text(b['author'])}" if b.get("author") else "")
            link = amazon_link(cfg, b)
            if link:
                paid = True
                name = f'<a href="{html.escape(link)}" rel="sponsored nofollow noopener" target="_blank">{name}</a>'
            items.append(f"<li>{name}" + (f": {text(b['why'])}" if b.get("why") else "") + "</li>")
        items += [f'<li><a href="{html.escape(l["url"])}" rel="sponsored nofollow noopener" target="_blank">{html.escape(l["name"])}</a></li>' for l in own]
        note = ("<p><small>Some links above are affiliate links. "
                + ("As an Amazon Associate I earn from qualifying purchases. " if cfg.get("amazon_tag") else "")
                + "It costs you nothing extra.</small></p>") if paid else ""
        out.append("<h2>Further reading</h2><ul>" + "".join(items) + "</ul>" + note)
    srcs = [s for s in art.get("sources") or [] if s.get("url")]
    if srcs:
        out.append("<h2>Sources</h2><ul>" + "".join(f'<li><a href="{html.escape(s["url"])}" rel="noopener" target="_blank">{html.escape(s.get("title", s["url"]))}</a></li>' for s in srcs) + "</ul>")
    if others:
        out.append("<h2>More stories</h2><ul>" + "".join(f'<li><a href="{html.escape(o["url"])}">{html.escape(o["title"])}</a></li>' for o in others) + "</ul>")
    out.append("<p><small>This article was written with the help of AI from our researched and fact-checked video script and the "
               "sources listed above. The illustrations are AI-generated artwork from the video.</small></p>")
    return "\n".join(x for x in out if x)


def affiliate_extras(entry):
    """The owner's own affiliate links (Income tab) that match this story."""
    try:
        from package import affiliate_links
        return affiliate_links({"topic": entry.get("topic", "")}, entry.get("video_title", ""), entry["article"].get("title", ""))
    except Exception:
        return []


# ---------------------------------------------------------------- publishing
def api(url, token, data=None, method=None):
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body, method=method, headers={
        "Authorization": f"Bearer {token}", "User-Agent": UA, **({"Content-Type": "application/json"} if body else {})})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.loads(r.read() or b"{}")


def explain(e):
    detail = e.read().decode("utf-8", "replace")[:500] if isinstance(e, urllib.error.HTTPError) else str(e)
    log("Blogger said:", getattr(e, "code", ""), detail)
    if "accessNotConfigured" in detail or "has not been used" in detail or "SERVICE_DISABLED" in detail:
        return "The Blogger API is switched off in your Google Cloud project. Turn it on (see Income > Blog > Set up)."
    if "insufficient" in detail.lower() or "scope" in detail.lower():
        return "The saved Google sign-in does not allow blog posts yet. Open Settings > Connect YouTube, sign in again, tick every box, and update YT_REFRESH_TOKEN."
    return f"Blogger refused the request ({getattr(e, 'code', 'error')})."


def find_blog(token, cfg):
    if cfg.get("blog_id"):
        b = api(BLOGGER + f"blogs/{urllib.parse.quote(str(cfg['blog_id']))}", token)
        return b["id"], b.get("url", ""), html.unescape(b.get("name", ""))
    blogs = api(BLOGGER + "users/self/blogs", token).get("items", [])
    if not blogs:
        raise WorkerError("No Blogger blog found on your Google account yet. Create one at blogger.com (see Income > Blog > Set up).")
    b = blogs[0]
    return b["id"], b.get("url", ""), html.unescape(b.get("name", ""))


def public_videos(token):
    try:
        from stats import channel_and_videos
        return [v for v in channel_and_videos(token)[1] if v.get("privacy") == "public"]
    except Exception as e:
        log("Could not read the channel's videos:", repr(e))
        return None


def match_video(job, entry, videos):
    if not videos:
        return None
    if job.get("youtube_id"):
        return next((v["id"] for v in videos if v["id"] == job["youtube_id"]), None)
    norm = lambda s: re.sub(r"[^a-z0-9 ]", "", str(s).lower()).strip()
    names = [norm(x) for x in (job.get("title"), entry.get("video_title")) if x]
    best, score = None, 0.0
    for v in videos:
        if v.get("short"):
            continue
        for n in names:
            r = difflib.SequenceMatcher(None, n, norm(v["title"])).ratio()
            if r > score:
                best, score = v["id"], r
    return best if score >= 0.8 else None


def image_live(entry):
    pics = entry.get("pictures") or []
    if not pics:
        return True
    url = pages_base() + f"blog-img/{entry['job_id']}/{pics[0]['file']}"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA}), timeout=30) as r:
            return r.status == 200
    except Exception:
        return False


def publish_phase(cfg):
    from upload import access_token
    old = read_json(BLOG / "status.json", {}) or {}
    status = dict(old)
    entries = [(p, read_json(p)) for p in sorted(BLOG.glob("*.json")) if p.name != "status.json"]
    entries = [(p, e) for p, e in entries if e and e.get("job_id")]
    waiting = [(p, e) for p, e in entries if e.get("status") == "written"]
    today = now().date().isoformat()
    sent_today = sum(1 for _, e in entries if e.get("status") == "published" and str(e.get("published", ""))[:10] == today)
    status["published"] = sum(1 for _, e in entries if e.get("status") == "published")  # the app's AdSense reminder uses this
    if not waiting and old.get("connected"):
        if status != old:
            write_json(BLOG / "status.json", status)
        return  # nothing to post, and the blog is known to be connected
    try:
        token = access_token()
        if not token:
            raise WorkerError("Connect YouTube in Settings first (the blog uses the same Google sign-in).")
        blog_id, blog_url, blog_name = find_blog(token, cfg)
        status.update(connected=True, blog_url=blog_url, blog_name=blog_name, message="")
    except Exception as e:
        status.update(connected=False, message=str(e) if isinstance(e, WorkerError) else explain(e))
        if status != old:
            write_json(BLOG / "status.json", status)
        return
    videos = None
    for path, entry in waiting:
        job = read_json(ROOT / "jobs" / f"{entry['job_id']}.json")
        if not job:  # the video was deleted in the app: drop its unpublished article
            log(f"Dropping article for deleted video {entry['job_id']}")
            path.unlink()
            subprocess.run(["git", "rm", "-rq", "--ignore-unmatch", f"app/blog-img/{entry['job_id']}"], cwd=ROOT, capture_output=True)
            continue
        if job.get("status") not in POSTED_STATES:
            continue  # not on YouTube yet
        if sent_today >= int(cfg.get("per_day", 1) or 1):
            log("Daily article limit reached; the rest go out tomorrow.")
            break
        if videos is None:
            videos = public_videos(token) or []
        vid = match_video(job, entry, videos)
        posted_at = parse_time(job.get("posted") or job.get("uploaded") or job.get("updated") or "")
        if not vid and posted_at and now() - posted_at < datetime.timedelta(days=3):
            log(f"Waiting for {job['topic']} to be Public on YouTube.")
            continue
        if not image_live(entry):
            log(f"Pictures for {job['topic']} are not online yet.")
            deploy_pages()
            continue
        others = [{"title": e["title"], "url": e["url"]} for _, e in sorted(entries, key=lambda x: str(x[1].get("published", "")), reverse=True)
                  if e.get("status") == "published" and e.get("url")][:3]
        art = entry["article"]
        labels = list(dict.fromkeys([str(x)[:40] for x in (art.get("labels") or [])] + ([entry["series"]] if entry.get("series") else [])))[:6]
        body = {"kind": "blogger#post", "title": art["title"][:150], "content": build_html(entry, cfg, vid, others), "labels": labels}
        try:
            post = api(BLOGGER + f"blogs/{blog_id}/posts/?isDraft=false", token, body, "POST")
        except Exception as e:
            entry["error"] = explain(e)
            write_json(path, entry)
            status["message"] = entry["error"]
            break
        entry.update(status="published", published=iso(), url=post.get("url", ""), post_id=post.get("id", ""),
                     youtube_id=vid or "", title=art["title"])
        entry.pop("error", None)
        write_json(path, entry)
        sent_today += 1
        status["published"] = status.get("published", 0) + 1
        log(f"Published: {entry['url']}")
    if status != old:
        write_json(BLOG / "status.json", status)


def main():
    cfg = config()
    if not cfg.get("enabled", True):
        log("Automatic blog is OFF in the app.")
        return
    BLOG.mkdir(exist_ok=True)
    sync()
    try:
        write_phase(cfg)
    except Exception as e:
        print("Writing step:", repr(e), file=sys.stderr)
    sync()
    publish_phase(cfg)
    save(["blog", "app/blog-img"], "Blog update")


if __name__ == "__main__":
    main()
