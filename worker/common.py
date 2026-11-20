"""Shared helpers for the Story Studio cloud workers.

Standard library only, so the GitHub Actions job needs nothing installed.
"""
import json
import os
import pathlib
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
UA = "StoryStudio/1.0 (open-source video script tool)"

# Free-tier Gemini models are found automatically (Google renames them often).
# To force a choice, set the GEMINI_MODELS repository variable, e.g. "gemini-2.5-flash".
FALLBACK_MODELS = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-flash-lite-latest", "gemini-2.5-flash-lite"]
_models_cache = None

# The channel's own visual identity. Every scene prompt is written for this,
# so the look stays consistent and original (not modelled on any channel).
HOUSE_STYLE = (
    "hand-painted gouache storybook illustration, warm muted palette of ochre, "
    "teal and deep brick red, visible paper grain, bold simple shapes and "
    "silhouettes, soft rim light, gentle depth haze, expressive faces, "
    "no text, no letters, no logos, no watermarks"
)

# Characters and objects are drawn separately on white, then cut out and animated over empty backgrounds.
SPRITE_STYLE = (
    "hand-painted gouache storybook character art, warm muted palette of ochre, teal and deep brick red, "
    "bold simple shapes, clean confident outline, expressive face, soft even light, "
    "no text, no letters, no logos, no watermarks"
)

# What the animation engine (animate.py) can do; the script writer may only use these.
ACTIONS = ["stand", "talk", "nod", "shake_head", "walk_in_left", "walk_in_right", "walk_out_left", "walk_out_right",
           "run_across", "jump", "celebrate", "tremble", "fall", "appear", "disappear", "approach", "retreat", "sneak",
           "turn", "strike", "point", "bow", "sway",
           # mostly for things: ships, carts, birds, crowns, cannonballs...
           "fly_across", "drop_in", "float", "spin", "sail_across"]
EFFECTS = ["none", "fire", "embers", "smoke", "rain", "snow", "dust", "sparkles", "fog", "lightning", "shake",
           "glow", "leaves", "birds", "explosion", "water"]
CAMERAS = ["static", "push_in", "pull_out", "pan_left", "pan_right", "tilt_up", "shake", "crash_zoom"]

# The channel's own recurring guide (an original design, not based on any other channel).
HOST = {
    "name": "Tara",
    "look": ("a cheerful young time-traveller girl, round friendly face, big curious eyes, "
             "short messy black hair under brass explorer goggles worn on her head, mustard-yellow jacket with "
             "rolled sleeves, teal scarf, brown satchel bag across her body, a rolled-up old map in one hand, "
             "brown boots"),
    "poses": {
        "talk": "standing facing the viewer, mouth open mid-sentence, one hand gesturing",
        "point": "pointing to the side with one arm stretched out, excited grin",
        "shrug": "shrugging with both palms up, eyebrows raised, half smile",
        "think": "hand on chin, looking up thoughtfully, one eyebrow raised",
        "shock": "jaw dropped, eyes wide, both hands on cheeks, surprised",
        "wave": "waving hello with a big happy smile",
        "laugh": "laughing with eyes closed, hand on belly",
        "worried": "nervous smile, sweat drop, hands clasped together",
    },
}


class WorkerError(Exception):
    """An error with a message the channel owner can understand."""

    def __init__(self, message, transient=False):
        super().__init__(message)
        self.transient = transient


def read_json(path, default=None):
    try:
        return json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def write_json(path, data):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def on_github():
    return bool(os.environ.get("GITHUB_REPOSITORY"))


def sync():
    """Get the latest project files, so a stale copy never redoes or overwrites newer work."""
    if on_github():
        subprocess.run(["git", "pull", "-q", "--rebase", "origin", "main"], cwd=ROOT)


def save(paths, message):
    """Commit the given folders and push straight away, so other jobs see the new state."""
    if not on_github():
        return
    for p in paths:
        if (ROOT / p).exists():
            subprocess.run(["git", "add", p], cwd=ROOT, check=True)
    if subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=ROOT).returncode == 0:
        return
    subprocess.run(["git", "commit", "-q", "-m", message], cwd=ROOT, check=True)
    for i in range(5):
        if subprocess.run(["git", "pull", "-q", "--rebase", "-X", "theirs", "origin", "main"], cwd=ROOT).returncode == 0 and \
                subprocess.run(["git", "push", "-q", "origin", "HEAD:main"], cwd=ROOT).returncode == 0:
            return
        subprocess.run(["git", "rebase", "--abort"], cwd=ROOT, capture_output=True)
        time.sleep(5 * (i + 1))
    raise RuntimeError("could not save to GitHub")


def stale(job, minutes):
    """True if a job has been 'in progress' far too long (its run probably crashed)."""
    import datetime
    t = job.get("updated") or job.get("created")
    try:
        when = datetime.datetime.fromisoformat(str(t).replace("Z", "+00:00"))
    except ValueError:
        return True
    return datetime.datetime.now(datetime.timezone.utc) - when > datetime.timedelta(minutes=minutes)


def http_json(url, data=None, headers=None, timeout=90):
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body, headers={"User-Agent": UA, **(headers or {})})
    if body is not None:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


# ---------------------------------------------------------------- Gemini
def _version(name):
    import re
    m = re.search(r"(\d+(?:\.\d+)?)", name)
    return float(m.group(1)) if m else 0.0


def gemini_models(key):
    """Ask Google which text models this key can use, best first."""
    global _models_cache
    if _models_cache is not None:
        return _models_cache
    override = [m.strip() for m in os.environ.get("GEMINI_MODELS", "").split(",") if m.strip()]
    if override:
        _models_cache = override
        return override
    found = []
    try:
        url = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200"
        for m in http_json(url, headers={"x-goog-api-key": key}).get("models", []):
            name = m.get("name", "").removeprefix("models/")
            if "generateContent" not in m.get("supportedGenerationMethods", []):
                continue
            if "flash" not in name or any(x in name for x in ("image", "tts", "audio", "live", "thinking", "exp", "preview", "embedding", "8b")):
                continue
            found.append(name)
    except Exception as e:
        print(f"Could not list models: {e}", file=sys.stderr)
    # Prefer the "latest" aliases, then the newest version; full flash before lite.
    found.sort(key=lambda n: ("latest" not in n, "lite" in n, -_version(n), len(n)))
    print("Gemini models to try:", found[:6] or FALLBACK_MODELS, file=sys.stderr)
    _models_cache = (found[:6] or FALLBACK_MODELS)
    return _models_cache


def gemini_json(prompt, system="", temperature=0.7, max_tries=3):
    """Ask Gemini for a JSON answer. Tries each free model in turn."""
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key:
        raise WorkerError("The Gemini key is missing. Add it as the GEMINI_API_KEY secret in GitHub.")
    models = gemini_models(key)
    payload = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": temperature, "responseMimeType": "application/json"},
    }
    if system:
        payload["systemInstruction"] = {"parts": [{"text": system}]}
    last = "no model answered"
    tried = []
    for model in models:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{urllib.parse.quote(model)}:generateContent"
        for attempt in range(max_tries):
            try:
                res = http_json(url, payload, {"x-goog-api-key": key}, timeout=150)
                parts = res.get("candidates", [{}])[0].get("content", {}).get("parts", [])
                text = "".join(p.get("text", "") for p in parts if not p.get("thought"))
                if not text.strip():
                    last = f"{model} returned an empty answer"
                    break
                return parse_json_text(text)
            except urllib.error.HTTPError as e:
                detail = e.read().decode("utf-8", "replace")[:600]
                last = f"{model}: HTTP {e.code}"
                print(f"Gemini {model} attempt {attempt + 1}: HTTP {e.code} {detail}", file=sys.stderr)
                if e.code == 429:
                    if "PerDay" in detail or "limit: 0" in detail:
                        last = f"{model}: free daily limit reached"
                        break  # no free quota left on this model today: try the next one
                    time.sleep(35 * (attempt + 1))  # per-minute limit: wait, then retry
                    continue
                if e.code in (500, 502, 503, 504):
                    if attempt == 0:  # busy: one quick retry, then move to the next model
                        time.sleep(8)
                        continue
                    break
                if e.code in (400, 401, 403) and "API key" in detail:
                    raise WorkerError("Google refused the Gemini key. Check the GEMINI_API_KEY secret.")
                break  # 404 (model renamed) or other: try the next model
            except (urllib.error.URLError, TimeoutError, ValueError) as e:
                last = f"{model}: {e}"
                print(f"Gemini {model} attempt {attempt + 1}: {e}", file=sys.stderr)
                time.sleep(5)
        tried.append(last)
    raise WorkerError("The AI service did not answer (" + "; ".join(tried)[:220] + "). It will try again within the hour.", transient=True)


def parse_json_text(text):
    text = text.strip()
    if text.startswith("```"):
        text = text.strip("`")
        text = text[text.find("\n") + 1:] if "\n" in text else text
    start = min([i for i in (text.find("{"), text.find("[")) if i >= 0], default=0)
    return json.loads(text[start:])


# ---------------------------------------------------------------- Wikipedia
WIKI_API = "https://en.wikipedia.org/w/api.php"


def wiki_search(query, limit=3):
    q = urllib.parse.urlencode({"action": "query", "list": "search", "srsearch": query,
                                "srlimit": limit, "format": "json", "formatversion": 2})
    try:
        return [h["title"] for h in http_json(f"{WIKI_API}?{q}")["query"]["search"]]
    except Exception:
        return []


def wiki_extract(title, max_chars=12000):
    q = urllib.parse.urlencode({"action": "query", "prop": "extracts", "explaintext": 1, "redirects": 1,
                                "titles": title, "format": "json", "formatversion": 2})
    try:
        page = http_json(f"{WIKI_API}?{q}")["query"]["pages"][0]
        text = page.get("extract", "")
        return {"title": page.get("title", title), "text": text[:max_chars],
                "url": "https://en.wikipedia.org/wiki/" + urllib.parse.quote(page.get("title", title).replace(" ", "_"))}
    except Exception:
        return None


def research(topic, theme="", max_pages=3):
    """Collect reference text for a topic, so the script is grounded in sources."""
    titles = []
    for q in (topic, f"{topic} {theme}".strip()):
        for t in wiki_search(q):
            if t not in titles:
                titles.append(t)
    titles = [t for i, t in enumerate(titles) if i == 0 or _related(t, topic, titles[0])]
    pages = [p for p in (wiki_extract(t) for t in titles[:max_pages]) if p and p["text"]]
    return pages


def _related(title, topic, best):
    """Keep only search results that share a real word with the topic (handles typos)."""
    import difflib
    stop = {"the", "of", "and", "a", "an", "in", "on", "to", "for", "how", "why", "what", "who", "history"}
    words = lambda s: {w for w in "".join(c.lower() if c.isalnum() else " " for c in s).split() if w not in stop and len(w) > 2}
    ref = words(topic) | words(best)
    return any(difflib.get_close_matches(w, ref, n=1, cutoff=0.8) for w in words(title))
