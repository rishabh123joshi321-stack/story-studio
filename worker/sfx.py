"""Background sound effects, made from scratch (no copyright, nothing to credit).

Each tag gives a quiet, looping ambience: fire crackle, crowd murmur, sea waves, wind, rain,
distant battle, church bells, thunder, birdsong. Plus a soft whoosh and a chime for the intro.
"""
import numpy as np

SR = 24000


def _noise(n, rng):
    return rng.standard_normal(n).astype(np.float32)


def _smooth(x, k):
    if k <= 1:
        return x
    return np.convolve(x, np.ones(k, dtype=np.float32) / k, mode="same")


def bed(tag, seconds, seed=0):
    n = int(seconds * SR)
    rng = np.random.default_rng(seed)
    t = np.arange(n) / SR
    if tag == "fire":
        base = _smooth(_noise(n, rng), 12) * 0.25
        crack = np.zeros(n, np.float32)
        for pos in rng.integers(0, n, int(seconds * 14)):
            L = int(rng.integers(40, 300))
            crack[pos:pos + L] += (rng.standard_normal(min(L, n - pos)) * np.exp(-np.arange(min(L, n - pos)) / (L / 4))).astype(np.float32) * rng.uniform(.3, 1)
        x = base + crack * 0.6
    elif tag == "crowd":
        x = _smooth(_noise(n, rng), 6) - _smooth(_noise(n, rng), 60)
        x *= (0.7 + 0.3 * np.sin(2 * np.pi * 0.23 * t + 1)) * (0.8 + 0.2 * np.sin(2 * np.pi * 0.07 * t))
    elif tag == "sea":
        x = _smooth(_noise(n, rng), 20) * (0.35 + 0.65 * (0.5 + 0.5 * np.sin(2 * np.pi * t / 7.5)) ** 2)
    elif tag == "wind":
        x = _smooth(_noise(n, rng), 30) * (0.5 + 0.5 * np.sin(2 * np.pi * t / 11 + rng.uniform(0, 6))) + _smooth(_noise(n, rng), 8) * 0.1
    elif tag == "rain":
        x = (_smooth(_noise(n, rng), 3) - _smooth(_noise(n, rng), 40)) * 0.6
    elif tag == "battle":
        x = _smooth(_noise(n, rng), 80) * 0.9
        for pos in rng.integers(0, n, int(seconds * 2.5)):
            L = min(int(SR * 0.25), n - pos)
            tt = np.arange(L) / SR
            ring = sum(np.sin(2 * np.pi * f * tt) for f in rng.uniform(1800, 4200, 3)) * np.exp(-tt * 18)
            x[pos:pos + L] += ring.astype(np.float32) * 0.25
    elif tag == "bells":
        x = np.zeros(n, np.float32)
        for k, pos in enumerate(range(0, n, int(SR * 2.4))):
            L = min(int(SR * 3), n - pos)
            tt = np.arange(L) / SR
            f0 = [392, 330, 294, 262][k % 4]
            x[pos:pos + L] += (sum(a * np.sin(2 * np.pi * f0 * m * tt) for m, a in ((1, 1), (2.0, .5), (2.76, .35), (5.4, .15))) * np.exp(-tt * 1.4)).astype(np.float32)
        x *= 0.35
    elif tag == "thunder":
        x = _smooth(_noise(n, rng), 200) * 3
        env = np.zeros(n, np.float32)
        for pos in range(int(SR * 0.5), n, int(SR * 9)):
            L = min(int(SR * 4), n - pos)
            env[pos:pos + L] += np.exp(-np.arange(L) / SR * 1.2)
        x = x * (0.15 + env)
    elif tag == "birds":
        x = _smooth(_noise(n, rng), 40) * 0.08
        for pos in rng.integers(0, n, int(seconds * 1.5)):
            L = min(int(SR * rng.uniform(.08, .2)), n - pos)
            tt = np.arange(L) / SR
            f = rng.uniform(2500, 4500) + 900 * np.sin(2 * np.pi * rng.uniform(15, 30) * tt)
            x[pos:pos + L] += (np.sin(2 * np.pi * np.cumsum(f) / SR) * np.hanning(L) * 0.3).astype(np.float32)
    else:
        return np.zeros(n, np.float32)
    x = x / (np.max(np.abs(x)) + 1e-6)
    return x.astype(np.float32)


def track(scenes, starts, durs, total, seed=0, level=0.10):
    """A whole-video ambience track following each scene's sfx tag, with soft fades."""
    out = np.zeros(int((total + 1) * SR), np.float32)
    cache = {}
    for sc, a, d in zip(scenes, starts, durs):
        tag = sc.get("sfx", "none")
        if tag in (None, "", "none"):
            continue
        if tag not in cache:
            cache[tag] = bed(tag, 30, seed + len(cache))
        b = cache[tag]
        i0, n = int(a * SR), int(d * SR)
        seg = np.resize(b, n)
        f = min(int(0.4 * SR), n // 3)
        if f > 0:
            seg[:f] *= np.linspace(0, 1, f)
            seg[-f:] *= np.linspace(1, 0, f)
        out[i0:i0 + n] += seg[:max(0, min(n, len(out) - i0))] * level
    return out


def whoosh(seconds=1.0, seed=1):
    n = int(seconds * SR)
    rng = np.random.default_rng(seed)
    t = np.linspace(0, 1, n)
    x = _smooth(_noise(n, rng), 10) * np.sin(np.pi * t) ** 2
    return (x / (np.max(np.abs(x)) + 1e-6) * 0.5).astype(np.float32)


def chime(seconds=2.5):
    n = int(seconds * SR)
    tt = np.arange(n) / SR
    x = sum(a * np.sin(2 * np.pi * f * tt) for f, a in ((523.25, 1), (659.25, .7), (783.99, .5), (1046.5, .25))) * np.exp(-tt * 1.8)
    return (x / np.max(np.abs(x)) * 0.45).astype(np.float32)
