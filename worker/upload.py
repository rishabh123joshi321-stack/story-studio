"""Upload approved videos to YouTube (Stage 6).

For each jobs/<id>.json with status "approved":
  1. Get a fresh access key from the saved YouTube sign-in (secrets YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN).
  2. Upload video.mp4 from the job's GitHub release with the approved title, description and tags.
  3. Add the thumbnail (long videos), and mark the job "uploaded" with its YouTube link.

Uploads are always Private: Google keeps uploads from apps it has not reviewed private anyway.
The owner makes each video Public, or schedules it, in YouTube Studio.
Standard library only.
"""
import datetime
import json
import os
import pathlib
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from common import ROOT, UA, WorkerError, read_json, save, stale, sync, write_json

WORK = pathlib.Path(os.environ.get("SS_WORK", "/tmp/ss-upload"))
CHUNK = 32 * 1024 * 1024


def log(*a):
    print(*a, flush=True)


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def access_token():
    cid, secret, refresh = (os.environ.get(k, "").strip() for k in ("YT_CLIENT_ID", "YT_CLIENT_SECRET", "YT_REFRESH_TOKEN"))
    if not (cid and secret and refresh):
        return None
    body = urllib.parse.urlencode({"client_id": cid, "client_secret": secret, "refresh_token": refresh,
                                   "grant_type": "refresh_token"}).encode()
    req = urllib.request.Request("https://oauth2.googleapis.com/token", data=body,
                                 headers={"Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read())["access_token"]
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:300]
        log("Token refresh failed:", e.code, detail)
        raise WorkerError("YouTube refused the saved sign-in. Open Settings > Connect YouTube and sign in again.")


def _api(url, token, data=None, method=None, headers=None, timeout=300):
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Authorization": f"Bearer {token}", "User-Agent": UA, **(headers or {})})
    return urllib.request.urlopen(req, timeout=timeout)


def _explain(e):
    detail = e.read().decode("utf-8", "replace")[:600]
    log("YouTube said:", e.code, detail)
    if "quotaExceeded" in detail or "uploadLimitExceeded" in detail:
        return WorkerError("YouTube's daily upload limit was reached. It will try again tomorrow.", transient=True)
    if e.code in (401, 403) and ("insufficient" in detail.lower() or "forbidden" in detail.lower()):
        return WorkerError("YouTube did not allow the upload. Open Settings > Connect YouTube and sign in again.")
    return WorkerError(f"YouTube upload failed (error {e.code}). It will try again within the hour.", transient=True)


def upload_video(token, path, pkg, job):
    meta = {
        "snippet": {
            "title": str(pkg.get("title") or job.get("title") or job["topic"])[:100],
            "description": str(pkg.get("description", ""))[:5000],
            "tags": [str(t) for t in pkg.get("tags", [])],
            "categoryId": str(pkg.get("category_id", "27")),
            "defaultLanguage": "en",
            "defaultAudioLanguage": "en",
        },
        "status": {
            "privacyStatus": "private",
            "selfDeclaredMadeForKids": bool(pkg.get("made_for_kids", False)),
            "containsSyntheticMedia": bool(pkg.get("ai_disclosure", False)),
            "embeddable": True,
        },
    }
    size = path.stat().st_size
    url = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status"
    try:
        with _api(url, token, json.dumps(meta).encode(), "POST", {
                "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": "video/mp4",
                "X-Upload-Content-Length": str(size)}, timeout=60) as r:
            session = r.headers["Location"]
    except urllib.error.HTTPError as e:
        raise _explain(e)
    sent = 0
    with open(path, "rb") as f:
        while sent < size:
            f.seek(sent)
            chunk = f.read(CHUNK)
            end = sent + len(chunk) - 1
            for attempt in range(5):
                try:
                    with _api(session, token, chunk, "PUT", {"Content-Length": str(len(chunk)),
                                                              "Content-Range": f"bytes {sent}-{end}/{size}"}) as r:
                        return json.loads(r.read())["id"]  # 200/201: the whole file has arrived
                except urllib.error.HTTPError as e:
                    if e.code == 308:  # chunk received, send the next one
                        rng = e.headers.get("Range", "")
                        sent = int(rng.split("-")[-1]) + 1 if rng else end + 1
                        break
                    if e.code in (500, 502, 503, 504) and attempt < 4:
                        time.sleep(10 * (attempt + 1))
                        continue
                    raise _explain(e)
                except (urllib.error.URLError, TimeoutError) as e:
                    log(f"  connection problem ({e}); retrying")
                    time.sleep(10 * (attempt + 1))
            else:
                raise WorkerError("The connection to YouTube kept dropping. It will try again within the hour.", transient=True)
            log(f"  uploaded {sent * 100 // size}%")
    raise WorkerError("YouTube did not confirm the upload. It will try again within the hour.", transient=True)


def set_thumbnail(token, video_id, path):
    url = f"https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId={video_id}&uploadType=media"
    try:
        with _api(url, token, path.read_bytes(), "POST", {"Content-Type": "image/jpeg"}, timeout=120):
            return True
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:300]
        log("Thumbnail not set:", e.code, detail)
        return False


def fetch_asset(job, name, dest):
    r = subprocess.run(["gh", "release", "download", f"video-{job['id']}", "-p", name, "-D", str(dest.parent), "--clobber"],
                       capture_output=True, text=True)
    return dest if r.returncode == 0 and dest.exists() else None


def process(path, token):
    sync()
    job = read_json(path)
    if job and job.get("status") == "uploading" and stale(job, 120):
        job["status"] = "approved"
    if not job or job.get("status") != "approved":
        return False
    pkg = read_json(ROOT / "packages" / f"{job['id']}.json") or {}
    log(f"=== Uploading {job['id']}: {pkg.get('title') or job['topic']}")
    job["status"] = "uploading"
    job["updated"] = now()
    job.pop("error", None)
    write_json(path, job)
    save(["jobs"], f"Uploading: {job['topic'][:60]}")
    folder = WORK / job["id"]
    folder.mkdir(parents=True, exist_ok=True)
    try:
        video = fetch_asset(job, "video.mp4", folder / "video.mp4")
        if not video:
            raise WorkerError("The finished video file could not be found. Tap Regenerate > Pictures to make it again.")
        vid = upload_video(token, video, pkg, job)
        log(f"  uploaded as https://youtu.be/{vid}")
        thumb_note = ""
        if job["format"] == "long":
            name = str(pkg.get("thumbnail") or "thumbnail.jpg").rsplit("/", 1)[-1]  # the one picked in Review
            thumb = fetch_asset(job, name, folder / name)
            if thumb and not set_thumbnail(token, vid, thumb):
                thumb_note = ("The thumbnail could not be added: YouTube allows custom thumbnails only after the channel "
                              "is verified with a phone number (youtube.com/verify). You can add it in YouTube Studio.")
        job.update(status="uploaded", youtube_id=vid, youtube_url=f"https://youtu.be/{vid}",
                   youtube_studio=f"https://studio.youtube.com/video/{vid}/edit", uploaded=now(), privacy="private")
        if thumb_note:
            job["note"] = thumb_note
        job.pop("upload_attempts", None)
    except Exception as e:
        print(repr(e), file=sys.stderr)
        job["upload_attempts"] = job.get("upload_attempts", 0) + 1
        transient = getattr(e, "transient", not isinstance(e, WorkerError))
        msg = str(e) if isinstance(e, WorkerError) else f"Something went wrong uploading ({type(e).__name__})."
        job["status"] = "approved" if transient and job["upload_attempts"] < 6 else "failed"
        if job["status"] == "failed":
            job["failed_step"] = "upload"
            msg += " Tap Try again in the Queue."
        job["error"] = msg
    job["updated"] = now()
    write_json(path, job)
    save(["jobs"], f"{'Uploaded' if job['status'] == 'uploaded' else 'Upload update'}: {job['topic'][:60]}")
    subprocess.run(["rm", "-rf", str(folder)])
    return True


def main():
    waiting = [p for p in sorted((ROOT / "jobs").glob("*.json")) if (read_json(p, {}) or {}).get("status") in ("approved", "uploading")]
    if not waiting:
        log("Nothing approved to upload.")
        return
    try:
        token = access_token()
    except WorkerError as e:
        for p in waiting:
            job = read_json(p)
            if job.get("status") == "approved" and job.get("error") != str(e):
                job["error"] = str(e)
                write_json(p, job)
        save(["jobs"], "YouTube sign-in needs renewing")
        log(e)
        return
    if not token:
        log("YouTube is not connected yet (Settings > Connect YouTube). Approved videos wait until it is.")
        return
    done = 0
    for p in waiting:
        if process(p, token):
            done += 1
    log(f"Uploaded {done} video(s).")


if __name__ == "__main__":
    main()
