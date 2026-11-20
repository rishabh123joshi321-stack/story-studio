# Story Studio

A zero-cost system for planning, making, reviewing and publishing original animated-history videos.

- `app/` is the control app (an installable web app hosted free on GitHub Pages).
- `jobs/` holds one small file per video request. The cloud workers pick these up.
- `.github/workflows/` holds the free cloud jobs (GitHub Actions).

Nothing is ever uploaded to YouTube without the owner tapping **Approve** in the app.
