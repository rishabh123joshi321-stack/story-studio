"""Original background music, made from scratch for every video.

Because the music is synthesised here (soft chord pads and a gentle pulse),
there is zero copyright risk and no attribution needed. If the owner adds
their own copyright-safe tracks to music/<mood>/ (for example from the
YouTube Audio Library), those are used instead.
"""
import random

import numpy as np

SR = 24000

# Chord progressions as semitone offsets from the key's root.
PROGRESSIONS = {
    "calm": [[0, 4, 7, 11], [9, 12, 16, 19], [5, 9, 12, 16], [7, 11, 14, 17]],      # Imaj7 vi IV V
    "warm": [[0, 4, 7], [7, 11, 14], [9, 12, 16], [5, 9, 12]],                      # I V vi IV
    "dramatic": [[0, 3, 7], [8, 12, 15], [3, 7, 10], [10, 14, 17]],                 # i VI III VII
    "epic": [[0, 3, 7], [8, 12, 15], [10, 14, 17], [7, 11, 14]],                    # i VI VII V
    "light": [[0, 4, 7], [5, 9, 12], [7, 11, 14], [0, 4, 7]],                       # I IV V I
}
TONE_TO_MOOD = {
    "Curious and warm": "warm", "Dramatic and suspenseful": "dramatic", "Light and funny": "light",
    "Calm and reflective": "calm", "Epic and inspiring": "epic", "Fun and witty": "light",
}


def _note(freq, dur, sr=SR):
    t = np.arange(int(dur * sr)) / sr
    # A soft pad: a few detuned sines with gentle harmonics.
    wave = sum(np.sin(2 * np.pi * freq * d * t) for d in (0.997, 1.0, 1.003)) / 3
    wave += 0.25 * np.sin(2 * np.pi * freq * 2 * t) + 0.08 * np.sin(2 * np.pi * freq * 3 * t)
    return wave


def make_music(seconds, tone, seed=None):
    rng = random.Random(seed)
    mood = TONE_TO_MOOD.get(tone, "warm")
    prog = PROGRESSIONS[mood]
    root = 220 * 2 ** (rng.choice([-5, -3, -2, 0, 2]) / 12)
    chord_len = rng.choice([4.0, 4.8, 5.4]) if mood in ("calm", "warm") else rng.choice([3.2, 3.6, 4.0])
    total = int(seconds * SR) + SR
    out = np.zeros(total)
    env_len = int(chord_len * SR)
    env = np.minimum(1, np.minimum(np.arange(env_len) / (0.9 * SR), (env_len - np.arange(env_len)) / (0.9 * SR)))
    pos, i = 0, 0
    while pos < total:
        chord = prog[i % len(prog)]
        seg = np.zeros(env_len)
        for semis in chord:
            seg += _note(root * 2 ** (semis / 12), chord_len)
        seg += 0.6 * _note(root / 2 * 2 ** (chord[0] / 12), chord_len)  # bass
        # gentle pulse on the chord's notes, an octave up
        if mood in ("dramatic", "epic", "light"):
            step = chord_len / 8
            for k in range(8):
                f = root * 2 * 2 ** (chord[k % len(chord)] / 12)
                n = _note(f, step) * np.exp(-np.arange(int(step * SR)) / (0.25 * SR))
                a = int(k * step * SR)
                seg[a:a + len(n)] += 0.35 * n[: max(0, env_len - a)]
        seg *= env
        end = min(total, pos + env_len)
        out[pos:end] += seg[: end - pos]
        pos += int(env_len * 0.85)  # overlap chords so they blend
        i += 1
    # (the mixer adds a low-pass filter to soften it further)
    out = out[: int(seconds * SR)]
    fade = int(min(3, seconds / 4) * SR)
    out[:fade] *= np.linspace(0, 1, fade)
    out[-fade:] *= np.linspace(1, 0, fade)
    peak = np.max(np.abs(out)) or 1
    return (out / peak * 0.5).astype(np.float32)
