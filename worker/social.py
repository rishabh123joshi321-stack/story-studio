"""Reach tactic 1: share each Short as an Instagram Reel and a Facebook Reel too.

Runs hourly. For every Short the owner has posted on YouTube (status "posted" or "uploaded"),
it sends the same vertical video, with the AI caption from packages/<id>.json, to:
  - Instagram (Reels) through the Instagram Graph API, and
  - the Facebook Page (Reels) through the Pages API.
Needs three GitHub secrets made once with Meta's free tools (steps are in the app's My to-dos):
META_PAGE_TOKEN (a long-lived Page access token), FB_PAGE_ID and IG_USER_ID.
Without them it does nothing, and the app's Queue offers Download + Copy caption instead.
The owner can switch either one off in the app (config/growth.json "social").
Standard library only.
"""
import datetime
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

from common import ROOT, UA, read_json, save, sync, write_json

GRAPH = "https://graph.facebook.com/v21.0/"
MAX_PER_RUN = 3


def log(*a):
    print(*a, flush=True)


def call(path, params=None, method="POST", url=None, headers=None):
    data = urllib.parse.urlencode(params or {}).encode() if method == "POST" else None
    full = url or (GRAPH + path + ("" if method == "POST" else "?" + urllib.parse.urlencode(params or {})))
    req = urllib.request.Request(full, data=data, method=method, headers={"User-Agent": UA, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:400]
        raise RuntimeError(f"Meta said {e.code}: {detail}") from None


def instagram(ig_user, token, video_url, caption):
    c = call(f"{ig_user}/media", {"media_type": "REELS", "video_url": video_url, "caption": caption,
                                  "share_to_feed": "true", "access_token": token})
    cid = c["id"]
    for _ in range(40):  # Instagram fetches and processes the video first (usually 1-3 minutes)
        time.sleep(15)
        st = call(cid, {"fields": "status_code,status", "access_token": token}, method="GET")
        if st.get("status_code") == "FINISHED":
            return call(f"{ig_user}/media_publish", {"creation_id": cid, "access_token": token})["id"]
        if st.get("status_code") in ("ERROR", "EXPIRED"):
            raise RuntimeError(f"Instagram could not process the video: {st.get('status', '')}")
    raise RuntimeError("Instagram took too long to process the video.")


def facebook(page, token, video_url, caption):
    start = call(f"{page}/video_reels", {"upload_phase": "start", "access_token": token})
    vid = start["video_id"]
    call("", method="POST", url=start["upload_url"], headers={"Authorization": f"OAuth {token}", "file_url": video_url})
    call(f"{page}/video_reels", {"upload_phase": "finish", "video_id": vid, "video_state": "PUBLISHED",
                                 "description": caption, "access_token": token})
    return vid


def main():
    token, page, ig = (os.environ.get(k, "").strip() for k in ("META_PAGE_TOKEN", "FB_PAGE_ID", "IG_USER_ID"))
    if not token or not (page or ig):
        log("Instagram/Facebook not connected yet (secrets META_PAGE_TOKEN, FB_PAGE_ID, IG_USER_ID). Nothing to do.")
        return
    sync()
    want = (read_json(ROOT / "config" / "growth.json", {}) or {}).get("social", {})
    targets = [(n, fn, who) for n, fn, who in (("instagram", instagram, ig), ("facebook", facebook, page))
               if who and want.get(n, True)]
    done = 0
    for path in sorted((ROOT / "jobs").glob("*.json")):
        if done >= MAX_PER_RUN:
            break
        job = read_json(path, {}) or {}
        if job.get("format") != "short" or job.get("status") not in ("posted", "uploaded") or not job.get("video"):
            continue
        social = job.get("social") or {}
        todo = [t for t in targets if not str(social.get(t[0], "")).startswith("ok") and social.get(t[0] + "_tries", 0) < 3]
        if not todo:
            continue
        pkg = read_json(ROOT / "packages" / f"{job['id']}.json", {}) or {}
        caption = (pkg.get("social_caption") or f"{pkg.get('title') or job['topic']}\n\nFull story on YouTube: Ember & Ink")[:2100]
        for name, fn, who in todo:
            try:
                pid = fn(who, token, job["video"], caption)
                social[name] = f"ok {pid}"
                log(f"{job['id']}: shared to {name} ({pid})")
            except Exception as e:
                social[name + "_tries"] = social.get(name + "_tries", 0) + 1
                social[name] = f"error: {e}"[:300]
                log(f"{job['id']}: {name} failed: {e}")
        social["updated"] = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
        sync()
        fresh = read_json(path, {}) or job  # keep anything another worker changed meanwhile
        fresh["social"] = social
        write_json(path, fresh)
        save(["jobs"], f"Shared Short to Reels: {job['topic'][:50]}")
        done += 1


if __name__ == "__main__":
    main()
