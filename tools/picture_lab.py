"""Try prompt and model variations on the free picture service and save the results to a 'lab' release.
Run from the Actions tab (Picture lab). Used to tune the look; never touches videos or jobs."""
import json
import os
import pathlib
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "worker"))
from common import HOST, HOUSE_STYLE, SPRITE_STYLE, UA  # noqa: E402

OUT = pathlib.Path("/tmp/lab")
OUT.mkdir(exist_ok=True)


def get(url, timeout=240):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers)


for u in ("https://image.pollinations.ai/models", "https://gen.pollinations.ai/image/models"):
    code, body, _ = get(u, 60)
    print(u, code, body[:1500].decode("utf-8", "replace"))

tests = json.loads(os.environ.get("LAB_TESTS") or "[]") or [
    {"name": "tara_now", "model": "flux", "w": 768, "h": 1216,
     "prompt": f"{HOST['look']}, standing facing the viewer, one hand gesturing, full body from head to feet, one single person, centered, isolated on a plain pure white background, no scenery, no floor, no shadow. Style: {SPRITE_STYLE}"},
    {"name": "tara_stylefirst", "model": "flux", "w": 768, "h": 1216,
     "prompt": f"Gouache storybook illustration, children's picture book character art, painted brush strokes. {HOST['look']}, standing, one hand gesturing, full body. Plain flat white background, nothing else."},
    {"name": "baker_stylefirst", "model": "flux", "w": 768, "h": 1216,
     "prompt": "Gouache storybook illustration, children's picture book character art, painted brush strokes. A stout 17th-century London baker, flour-dusted apron, brown waistcoat, linen cap, round red face, panicked expression, arms raised, full body. Plain flat white background, nothing else."},
    {"name": "place_stylefirst", "model": "flux", "w": 768, "h": 1456,
     "prompt": f"Gouache storybook illustration, children's picture book background painting. A narrow 1666 London lane of timber houses at night, a small bakery with a glowing oven window, empty, no people. Style: {HOUSE_STYLE}"},
    {"name": "baker_turbo", "model": "turbo", "w": 768, "h": 1216,
     "prompt": "Gouache storybook illustration, children's picture book character art. A stout 17th-century London baker, flour-dusted apron, panicked, arms raised, full body. Plain flat white background."},
]
if os.environ.get("CF_ACCOUNT_ID") and os.environ.get("CF_API_TOKEN"):  # once Cloudflare is set up, test it instead
    tests = json.loads(os.environ.get("LAB_TESTS") or "[]") or [dict(t, cf=True) for t in tests if t["name"].endswith("stylefirst") or t["name"] == "tara_now"]


def cloudflare(prompt, seed):
    import base64
    url = f"https://api.cloudflare.com/client/v4/accounts/{os.environ['CF_ACCOUNT_ID']}/ai/run/@cf/black-forest-labs/flux-1-schnell"
    req = urllib.request.Request(url, data=json.dumps({"prompt": prompt, "steps": 6, "seed": seed}).encode(),
                                 headers={"Authorization": f"Bearer {os.environ['CF_API_TOKEN']}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return 200, base64.b64decode(json.loads(r.read())["result"]["image"]), {}
    except urllib.error.HTTPError as e:
        return e.code, e.read(), {}


made = []
for i, t in enumerate(tests):
    if t.get("cf"):
        code, body, _ = cloudflare(t["prompt"], 4242)
        print(t["name"], "cloudflare", code, len(body), body[:300] if code != 200 else "")
        if code == 200:
            p = OUT / f"{t['name']}_cf.jpg"
            p.write_bytes(body)
            made.append(str(p))
        continue
    if i:
        time.sleep(50)
    q = urllib.parse.urlencode({"width": t["w"], "height": t["h"], "seed": 4242, "model": t["model"], "nologo": "true", "private": "true"})
    url = "https://image.pollinations.ai/prompt/" + urllib.parse.quote(t["prompt"][:900]) + "?" + q
    for attempt in range(4):
        code, body, headers = get(url)
        print(t["name"], code, len(body), {k: v for k, v in headers.items() if k.lower().startswith(("x-", "content-type"))})
        if code == 200:
            p = OUT / f"{t['name']}.jpg"
            p.write_bytes(body)
            made.append(str(p))
            break
        print(body[:600].decode("utf-8", "replace"))
        time.sleep(30)
tag = "picture-lab"
subprocess.run(["gh", "release", "delete", tag, "--yes", "--cleanup-tag"], capture_output=True)
subprocess.run(["gh", "release", "create", tag, *made, "--title", "Picture lab", "--notes", "Test pictures (not used in videos).",
                "--prerelease", "--latest=false"], check=True)
