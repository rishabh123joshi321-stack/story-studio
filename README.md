# Story Studio

A zero-cost system for planning, making, reviewing and publishing original animated-history videos.

- `app/` is the control app (an installable web app hosted free on GitHub Pages).
- `jobs/` holds one small file per video request. The cloud workers pick these up.
- `.github/workflows/` holds the free cloud jobs (GitHub Actions).

Nothing is ever uploaded to YouTube without the owner tapping **Approve** in the app.

## What makes the videos (all free)

- Scripts and topic ideas: Google Gemini free tier, grounded in Wikipedia.
- Pictures: free AI image service (Pollinations, FLUX model), with Gemini images as a backup.
- Voice: [Kokoro](https://github.com/hexgrad/kokoro), an open-source voice (Apache 2.0).
- Music: original music generated fresh for each video (`worker/music.py`), so there are no copyright claims. You can drop your own copyright-safe MP3s into `music/` instead.
- Captions font: Anton (SIL Open Font License).
- Blog: each long video also becomes a full article on the owner's free Blogger blog (`worker/blog.py`), posted automatically once the video is Public.
- Finished videos are stored as GitHub releases until they are approved and uploaded.
