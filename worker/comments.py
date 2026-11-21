"""Growth tactic 7: AI-drafted replies to viewer comments, sent only after the owner approves each one.

Every few hours:
  1. Send the replies the owner approved in the app. The app saves each decision as its own
     file, comments/approved/<comment id>.json ({"reply": "..."} or {"skip": true}), so the app
     and this worker never edit the same file.
  2. Read new comments on the channel's videos that the channel has not answered yet, and ask
     Gemini (one request per batch) for a short, friendly draft reply to each.
Results: comments/inbox.json, shown in the app's Review tab.

Reading comments needs youtube.readonly; sending replies needs youtube.force-ssl (both in the app's sign-in).
Nothing is ever posted without the owner's approval. Standard library only.
"""
import datetime
import json
import sys
import urllib.error
import urllib.parse

from common import ROOT, gemini_json, read_json, save, sync, write_json
from upload import _api, access_token, log

DATA = "https://www.googleapis.com/youtube/v3/"
INBOX = ROOT / "comments" / "inbox.json"
APPROVED = ROOT / "comments" / "approved"
KEEP_DAYS = 21


def now():
    return datetime.datetime.now(datetime.timezone.utc)


def get(path, token, **params):
    with _api(DATA + path + "?" + urllib.parse.urlencode(params), token, timeout=60) as r:
        return json.loads(r.read())


def send_approved(token, inbox):
    sent = 0
    by_id = {i["id"]: i for i in inbox["items"]}
    for f in sorted(APPROVED.glob("*.json")) if APPROVED.exists() else []:
        d = read_json(f, {}) or {}
        item = by_id.get(f.stem)
        if item and d.get("skip"):
            item.update(status="skipped", done=now().isoformat(timespec="seconds"))
        elif item and str(d.get("reply", "")).strip():
            text = str(d["reply"]).strip()[:1000]
            body = json.dumps({"snippet": {"parentId": item["id"], "textOriginal": text}}).encode()
            try:
                with _api(DATA + "comments?part=snippet", token, body, "POST", {"Content-Type": "application/json"}, timeout=60):
                    pass
                item.update(status="sent", reply=text, done=now().isoformat(timespec="seconds"))
                item.pop("error", None)
                sent += 1
            except urllib.error.HTTPError as e:
                detail = e.read().decode("utf-8", "replace")[:300]
                log("Reply not sent:", e.code, detail)
                if e.code in (401, 403):
                    inbox["note"] = ("YouTube did not allow the app to reply. Open Settings > Connect YouTube, tap Sign in with Google, "
                                     "tick every box, then update YT_REFRESH_TOKEN on GitHub.")
                    item["error"] = "Not sent yet: YouTube sign-in needs the reply permission."
                    continue  # keep the approval file so it is sent after the sign-in is fixed
                item.update(status="failed", error=f"YouTube refused this reply (error {e.code}). The comment may have been deleted.")
        f.unlink()
    return sent


def fetch_new(token, inbox):
    me = get("channels", token, part="id", mine="true").get("items", [{}])[0].get("id")
    if not me:
        return []
    data = get("commentThreads", token, part="snippet,replies", allThreadsRelatedToChannelId=me, order="time",
               maxResults=50, textFormat="plainText")
    known = {i["id"] for i in inbox["items"]}
    cutoff = (now() - datetime.timedelta(days=14)).isoformat()
    stats = read_json(ROOT / "stats" / "latest.json", {}) or {}
    titles = {v["id"]: v["title"] for v in stats.get("recent", [])}
    new = []
    for t in data.get("items", []):
        top = t["snippet"]["topLevelComment"]
        s = top["snippet"]
        author = (s.get("authorChannelId") or {}).get("value")
        if top["id"] in known or author == me or s.get("publishedAt", "") < cutoff[:19]:
            continue
        if any((r["snippet"].get("authorChannelId") or {}).get("value") == me for r in (t.get("replies") or {}).get("comments", [])):
            continue  # already answered (perhaps in the YouTube app)
        new.append({"id": top["id"], "video_id": s.get("videoId") or t["snippet"].get("videoId"),
                    "video_title": titles.get(s.get("videoId") or t["snippet"].get("videoId"), ""),
                    "author": str(s.get("authorDisplayName", ""))[:60], "text": str(s.get("textOriginal") or s.get("textDisplay", ""))[:1500],
                    "published": s.get("publishedAt"), "likes": s.get("likeCount", 0), "status": "new"})
    return new[:20]


def draft(new):
    lines = "\n".join(f'[{n}] On "{c["video_title"] or "a video"}": {c["text"]}' for n, c in enumerate(new))
    prompt = f"""You help the owner of an animated-history YouTube channel ("Ember & Ink") reply to viewer comments.
For each comment write a short, warm, human reply (1 to 3 sentences, under 280 characters) in the comment's language.
Thank people, answer questions accurately (say honestly if unsure), and when it fits invite them to share their view or
suggest a topic. No links, no emojis spam (at most one emoji), never argue, never promise things.
If a comment is spam, a scam, hateful, or needs no reply, set "skip" to true.
Comments:
{lines}
Return JSON: {{"replies": [{{"n": 0, "reply": "...", "skip": false, "question": true}}]}}"""
    data = gemini_json(prompt, "You write kind, accurate replies. Answer only with JSON.", temperature=0.6)
    out = data.get("replies", []) if isinstance(data, dict) else []
    for r in out:
        try:
            c = new[int(r.get("n"))]
        except (TypeError, ValueError, IndexError):
            continue
        c["draft"] = str(r.get("reply", "")).strip()[:500]
        c["question"] = bool(r.get("question"))
        if r.get("skip"):
            c["status"], c["ai_skip"] = "suggest_skip", True


def main():
    sync()
    token = access_token()
    inbox = read_json(INBOX, {}) or {}
    inbox.setdefault("items", [])
    inbox["note"] = ""
    if not token:
        inbox["note"] = "Connect YouTube in Settings first."
        write_json(INBOX, inbox)
        return
    sent = send_approved(token, inbox)
    if "--send-only" not in sys.argv:
        try:
            new = fetch_new(token, inbox)
            if new:
                try:
                    draft(new)
                except Exception as e:  # drafts can be written later; still show the comments
                    log("Drafts skipped:", repr(e))
                inbox["items"] = new + inbox["items"]
            log(f"{len(new)} new comment(s).")
        except urllib.error.HTTPError as e:
            log("Comments not read:", e.code, e.read().decode("utf-8", "replace")[:300])
            if e.code in (401, 403):
                inbox["note"] = "YouTube did not allow reading comments. Sign in again in Settings > Connect YouTube and tick every box."
    cutoff = (now() - datetime.timedelta(days=KEEP_DAYS)).isoformat()
    inbox["items"] = [i for i in inbox["items"] if i.get("status") in ("new", "suggest_skip") or (i.get("done") or "") > cutoff][:150]
    inbox["updated"] = now().isoformat(timespec="seconds")
    write_json(INBOX, inbox)
    save(["comments"], f"Comments: {sent} repl{'y' if sent == 1 else 'ies'} sent")


if __name__ == "__main__":
    main()
