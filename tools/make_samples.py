"""Make sample characters, backgrounds and a short animated clip with FLUX.1 schnell
(the same model as the Cloudflare picture source), through its free public demo.
Run from the Actions tab (Make samples). Results go to the 'samples' prerelease."""
import pathlib
import shutil
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "worker"))
from PIL import Image  # noqa: E402

import animate  # noqa: E402
from common import HOST  # noqa: E402
from overlays import cut_out_white, font, host_background, story_overlay  # noqa: E402

OUT = pathlib.Path("/tmp/samples")
OUT.mkdir(exist_ok=True)
CACHE = pathlib.Path("/tmp/ss-cache")
STYLE = ("Gouache storybook illustration, children's picture book art, visible painted brush strokes and paper grain, "
         "warm muted palette of ochre, teal and deep brick red, soft light, expressive friendly faces")
CHAR = "full body from head to feet, standing, plain flat white background, nothing else, no shadow, no text"
PICS = {
    "tara_talk": f"{STYLE}. {HOST['look']}, smiling and talking to the viewer, one hand gesturing, {CHAR}",
    "tara_point": f"{STYLE}. {HOST['look']}, pointing to the side with an excited grin, {CHAR}",
    "baker_sleepy": f"{STYLE}. A stout middle-aged 17th-century London baker, flour-dusted white apron over a brown waistcoat, linen cap, rosy round face, yawning sleepily holding a candle, {CHAR}",
    "baker_panic": f"{STYLE}. A stout middle-aged 17th-century London baker, flour-dusted white apron over a brown waistcoat, linen cap, rosy round face, panicking with both arms raised, mouth open, {CHAR}",
    "bucket_man": f"{STYLE}. A thin young 17th-century Londoner in a grey coat and black hat carrying a leather fire bucket of water, determined face, {CHAR}",
    "lane_night": f"{STYLE}. An empty narrow 1666 London lane of leaning timber houses at night, a small bakery with a glowing oven window, cobblestones, no people, wide open ground in the lower part",
    "lane_fire": f"{STYLE}. An empty narrow 1666 London lane of leaning timber houses on fire, orange flames and smoke in the night sky, cobblestones, no people, wide open ground in the lower part",
}
SPACES = ["black-forest-labs/FLUX.1-schnell", "multimodalart/FLUX.1-schnell"]


def draw(name, prompt, w, h):
    from gradio_client import Client
    last = None
    for space in SPACES:
        for attempt in range(3):
            try:
                client = Client(space, verbose=False)
                res = client.predict(prompt=prompt, seed=4242, randomize_seed=False, width=w, height=h,
                                     num_inference_steps=4, api_name="/infer")
                path = res[0] if isinstance(res, (list, tuple)) else res
                path = path.get("path", path) if isinstance(path, dict) else path
                dest = OUT / f"{name}.png"
                Image.open(path).convert("RGB").save(dest)
                print(f"{name}: drawn with {space}", flush=True)
                return dest
            except Exception as e:
                last = e
                print(f"{name}: {space} attempt {attempt + 1} failed: {str(e)[:300]}", flush=True)
                time.sleep(20)
    raise RuntimeError(f"could not draw {name}: {last}")


made = {}
for name, prompt in PICS.items():
    tall = not name.startswith("lane")
    made[name] = draw(name, prompt, 768 if tall else 768, 1152 if tall else 1344)
cut = {}
for name in made:
    if name.startswith("lane"):
        continue
    try:
        cut[name] = cut_out_white(made[name], OUT / f"{name}_cut.png")
    except Exception as e:
        print(f"cut-out {name} failed: {e}")

font(CACHE, "Anton-Regular.ttf", 20)
font(CACHE, "PatrickHand-Regular.ttf", 20)
fonts = {"display": str(CACHE / "fonts" / "Anton-Regular.ttf"), "hand": str(CACHE / "fonts" / "PatrickHand-Regular.ttf")}
W, H, FPS = 720, 1280, 30
shots = [
    {"kind": "title", "bg": made["lane_night"], "camera": "push_in", "title": "The Great Fire", "subtitle": "London, 1666", "secs": 2.2},
    {"kind": "story", "bg": made["lane_night"], "camera": "push_in", "effect": "embers", "secs": 3.2, "label": "Pudding Lane, 1666",
     "chars": [("baker_sleepy", "baker_panic", "walk_in_left", "center")]},
    {"kind": "story", "bg": made["lane_fire"], "camera": "shake", "effect": "fire", "secs": 3.0,
     "chars": [("baker_panic", None, "jump", "left"), ("bucket_man", None, "run_across", "right")], "bubble": "Fire! Wake up!"},
    {"kind": "host", "secs": 3.2, "note": "A city made of wood...", "chars": [("tara_talk", "tara_point", "talk", "center")]},
    {"kind": "story", "bg": made["lane_fire"], "camera": "crash_zoom", "effect": "smoke", "secs": 3.4,
     "chars": [("bucket_man", None, "walk_in_right", "center")], "fact": "London had no fire brigade in 1666."},
]
clips = []
for i, s in enumerate(shots):
    chars = []
    for a, b, act, pos in s.get("chars", []):
        if a in cut:
            chars.append({"a": cut[a], "b": cut.get(b) if b else None, "action": act, "pos": pos})
    spec = {"kind": s["kind"], "camera": s.get("camera", "static"), "effect": s.get("effect", "none"), "chars": chars,
            "title": s.get("title", ""), "subtitle": s.get("subtitle", ""), "fact": s.get("fact", "")}
    if s["kind"] == "host":
        spec["bg"] = host_background(W, H, s.get("note"), "", CACHE, OUT / f"hostbg{i}.png")
    else:
        spec["bg"] = s["bg"]
        if s.get("label") or s.get("bubble"):
            spec["overlay"] = story_overlay(W, H, s.get("label"), s.get("bubble"), "right", CACHE, OUT / f"ov{i}.png")
    clip = OUT / f"shot{i}.mp4"
    animate.render_shot(spec, W, H, FPS, int(s["secs"] * FPS), clip, fonts, 7 + i)
    clips.append(clip)
(OUT / "list.txt").write_text("".join(f"file '{c}'\n" for c in clips))
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(OUT / "list.txt"),
                "-vf", "scale=1080:1920:flags=lanczos", "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p",
                "-movflags", "+faststart", str(OUT / "sample_clip.mp4")], check=True)
# one sheet with every character and background
thumbs = [Image.open(made[n]).convert("RGB") for n in PICS]
hh = 640
thumbs = [t.resize((int(t.width * hh / t.height), hh)) for t in thumbs]
sheet = Image.new("RGB", (sum(t.width for t in thumbs) + 10 * (len(thumbs) + 1), hh + 20), (240, 236, 228))
x = 10
for t in thumbs:
    sheet.paste(t, (x, 10))
    x += t.width + 10
sheet.save(OUT / "sample_sheet.jpg", quality=90)
files = [str(OUT / "sample_clip.mp4"), str(OUT / "sample_sheet.jpg")] + [str(p) for p in made.values()]
subprocess.run(["gh", "release", "delete", "samples", "--yes", "--cleanup-tag"], capture_output=True)
subprocess.run(["gh", "release", "create", "samples", *files, "--title", "Samples", "--notes",
                "Sample characters, backgrounds and a short clip (FLUX.1 schnell). Not a real video.",
                "--prerelease", "--latest=false"], check=True)
shutil.rmtree(OUT / "unused", ignore_errors=True)
