#!/usr/bin/env python3
"""HUK seed-content generator: deterministic procedural tracks, no copyright.

Three styles (synthwave, lofi, dance), at least 9 tracks total. WAV 44.1 kHz
stereo is synthesized with numpy, then encoded to MP3 192k via ffmpeg with
bit-exact flags so two runs produce byte-identical files on the same encoder
build. Output directory comes from --out (default: seed-audio/). A manifest
(sidecar JSON) records the title/style metadata that cannot be derived from
the audio bytes.
"""
import argparse
import json
import os
import subprocess
import sys

import numpy as np
import wave

SR = 44100

def note_freq(semitones_from_a4):
    return 440.0 * (2 ** (semitones_from_a4 / 12.0))

# A minor scale semitones from A4
AMIN_PENT = [0, 3, 5, 7, 10]  # pentatonic

def t_axis(dur):
    return np.linspace(0, dur, int(SR * dur), endpoint=False)

def env_ad(n, attack, decay_power=4.0):
    """Attack-decay envelope."""
    a = int(attack * SR)
    e = np.ones(n)
    if a > 0:
        e[:a] = np.linspace(0, 1, a)
    d = np.exp(-decay_power * np.linspace(0, 1, n))
    return e * d

def osc_saw(freq, dur, detune_cents=0.0):
    t = t_axis(dur)
    f = freq * (2 ** (detune_cents / 1200.0))
    ph = (f * t) % 1.0
    return 2.0 * ph - 1.0

def osc_square(freq, dur, duty=0.5):
    t = t_axis(dur)
    ph = (freq * t) % 1.0
    return np.where(ph < duty, 1.0, -1.0)

def lowpass(x, alpha):
    """One-pole lowpass (vectorized); alpha 0..1 (smaller = darker)."""
    from scipy.signal import lfilter
    return lfilter([alpha], [1, -(1 - alpha)], x)

def kick(dur=0.35):
    t = t_axis(dur)
    f = 140 * np.exp(-t * 18) + 45
    ph = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(ph) * np.exp(-t * 9)

def hat(dur=0.06, bright=True):
    n = int(SR * dur)
    x = np.random.default_rng(7).uniform(-1, 1, n)
    x = lowpass(x, 0.9 if bright else 0.35)
    return x * env_ad(n, 0.001, 18)

def snare(dur=0.18):
    n = int(SR * dur)
    t = t_axis(dur)
    noise = np.random.default_rng(3).uniform(-1, 1, n)
    noise = lowpass(noise, 0.5)
    tone = np.sin(2 * np.pi * 190 * t) * 0.5
    return (noise * 0.7 + tone) * np.exp(-t * 22)

def pluck(freq, dur, amp=1.0, bright=0.25):
    """Plucky arp voice: saw through a lowpass with decay."""
    x = osc_saw(freq, dur)
    x = lowpass(x, bright)
    n = len(x)
    return x * env_ad(n, 0.004, 6) * amp

def pad_chord(freqs, dur, amp=1.0, alpha=0.12):
    """Warm pad: detuned saws."""
    n = int(SR * dur)
    out = np.zeros(n)
    for f in freqs:
        out += osc_saw(f, dur, detune_cents=-7) * 0.5
        out += osc_saw(f, dur, detune_cents=7) * 0.5
    out = lowpass(out, alpha)
    a = int(0.4 * SR)
    e = np.ones(n)
    e[:a] = np.linspace(0, 1, a)
    e[-a:] = np.linspace(1, 0, a)
    return out * e * amp / max(1, len(freqs))

def bass_note(freq, dur, amp=1.0, alpha=0.18):
    x = osc_square(freq, dur, 0.55) * 0.6 + osc_saw(freq, dur) * 0.4
    x = lowpass(x, alpha)
    n = len(x)
    e = env_ad(n, 0.005, 2.0)
    return x * e * amp

def vinyl_crackle(dur, seed=42):
    rng = np.random.default_rng(seed)
    n = int(SR * dur)
    out = np.zeros(n)
    n_pops = int(dur * 90)
    idx = rng.integers(0, n - 100, n_pops)
    for i in idx:
        pop = rng.uniform(0.15, 0.6)
        out[i:i + 40] += rng.uniform(-pop, pop, 40)
    out = lowpass(out, 0.25)
    out += rng.uniform(-1, 1, n) * 0.012  # pink-ish noise floor
    return out

def put(buf, start_s, sig, gain=1.0):
    i = int(start_s * SR)
    j = min(i + len(sig), len(buf))
    if j > i:
        buf[i:j] += sig[: j - i] * gain

def finalize(buf_l, buf_r, path_wav, path_mp3, fade=1.5):
    peak = max(1e-9, np.max(np.abs(buf_l)), np.max(np.abs(buf_r)))
    scale = 0.82 / peak
    n = len(buf_l)
    fade_n = int(fade * SR)
    envelope = np.ones(n)
    envelope[:fade_n] = np.linspace(0, 1, fade_n)
    envelope[-fade_n:] = np.linspace(1, 0, fade_n)
    L = (buf_l * scale * envelope)
    R = (buf_r * scale * envelope)
    data = np.empty(2 * n, dtype=np.int16)
    data[0::2] = np.clip(L * 32767, -32768, 32767).astype(np.int16)
    data[1::2] = np.clip(R * 32767, -32768, 32767).astype(np.int16)
    with wave.open(path_wav, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(data.tobytes())
    # bitexact flags strip encoder metadata so reruns are byte-identical;
    # -nostdin keeps ffmpeg from blocking on a non-interactive stdin.
    subprocess.run([
        "ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-i", path_wav,
        "-codec:a", "libmp3lame", "-b:a", "192k",
        "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact",
        path_mp3,
    ], check=True)
    os.remove(path_wav)
    print(f"  -> {os.path.basename(path_mp3)} ({os.path.getsize(path_mp3)//1024} KB)")

# ─────────────────────────────────────────────────────────────
# STYLE 1: SYNTHWAVE (88 BPM, A minor)
# ─────────────────────────────────────────────────────────────
def make_synthwave(seed, bars=36):
    rng = np.random.default_rng(seed)
    bpm = 88
    beat = 60 / bpm
    dur = bars * 4 * beat + 2
    buf_l = np.zeros(int(SR * dur))
    buf_r = np.zeros(int(SR * dur))
    # Am - F - C - G progression (semitones from A4)
    roots = [-12, -16, -9, -14]
    chord_sets = [[0, 3, 7], [0, 4, 7], [0, 4, 7], [0, 4, 7]]
    for bar in range(bars):
        t0 = bar * 4 * beat
        root = roots[bar % 4]
        # pad
        freqs = [note_freq(root + iv - 12) for iv in chord_sets[bar % 4]]
        p = pad_chord(freqs, 4 * beat, amp=0.30, alpha=0.10)
        put(buf_l, t0, p, 0.9)
        put(buf_r, t0, p * 0.92, 0.9)
        # bass in eighths
        for k in range(8):
            bf = note_freq(root - 24) if k % 4 != 3 else note_freq(root - 24 + 3)
            b = bass_note(bf, beat * 0.42, amp=0.5, alpha=0.15)
            put(buf_l, t0 + k * beat / 2, b, 0.85)
            put(buf_r, t0 + k * beat / 2, b, 0.85)
        # arp in sixteenths (pentatonic)
        for k in range(16):
            deg = AMIN_PENT[rng.integers(0, 5)] + (12 if rng.random() < 0.3 else 0)
            af = note_freq(root + 12 + deg)
            a = pluck(af, beat * 0.5, amp=0.22, bright=0.30)
            pan_left = k % 2 == 0
            put(buf_l, t0 + k * beat / 4, a, 1.0 if pan_left else 0.6)
            put(buf_r, t0 + k * beat / 4, a, 0.6 if pan_left else 1.0)
        # drums
        for k in range(4):
            put(buf_l, t0 + k * beat, kick(), 0.72)
            put(buf_r, t0 + k * beat, kick(), 0.72)
            if k in (1, 3):
                s = snare()
                put(buf_l, t0 + k * beat, s, 0.5)
                put(buf_r, t0 + k * beat, s, 0.5)
            for hh in (0.5, 1.5, 2.5, 3.5):
                h = hat(bright=True)
                put(buf_l, t0 + k * beat + hh * beat / 2, h, 0.20)
                put(buf_r, t0 + k * beat + hh * beat / 2, h, 0.28)
    return buf_l, buf_r

# ─────────────────────────────────────────────────────────────
# STYLE 2: LOFI (72 BPM, seventh chords, vinyl)
# ─────────────────────────────────────────────────────────────
def make_lofi(seed, bars=30):
    rng = np.random.default_rng(seed)
    bpm = 72
    beat = 60 / bpm
    dur = bars * 4 * beat + 2
    buf_l = np.zeros(int(SR * dur))
    buf_r = np.zeros(int(SR * dur))
    crack = vinyl_crackle(dur, seed=seed + 100)
    buf_l += crack * 0.5
    buf_r += np.roll(crack, 2205) * 0.5
    # progression: Am7 - Dm7 - Fmaj7 - E7
    roots = [-12, -7, -16, -5]
    chords = [[0, 3, 7, 10], [0, 3, 7, 10], [0, 4, 7, 11], [0, 4, 7, 10]]
    for bar in range(bars):
        t0 = bar * 4 * beat
        root = roots[bar % 4]
        # soft, very dark pad
        freqs = [note_freq(root + iv) for iv in chords[bar % 4]]
        p = pad_chord(freqs, 4 * beat, amp=0.26, alpha=0.055)
        put(buf_l, t0, p, 0.85)
        put(buf_r, t0, p, 0.85)
        # bass on 1 and 3
        for k in (0, 2):
            b = bass_note(note_freq(root - 12), beat * 1.6, amp=0.42, alpha=0.10)
            put(buf_l, t0 + k * beat, b, 0.8)
            put(buf_r, t0 + k * beat, b, 0.8)
        # jazz chord plucks, syncopated
        for k, off in [(0.5, 0), (2.5, 1), (3.5, 2)]:
            iv = chords[bar % 4][int(off) % 4]
            f = note_freq(root + iv + 12)
            a = pluck(f, beat * 0.9, amp=0.16, bright=0.12)
            put(buf_l, t0 + off * beat, a, 0.8)
            put(buf_r, t0 + off * beat, a, 1.0)
        # sparse soft drums
        for k in range(4):
            put(buf_l, t0 + k * beat, kick(0.3), 0.34)
            put(buf_r, t0 + k * beat, kick(0.3), 0.34)
            if k == 2:
                s = snare(0.14)
                put(buf_l, t0 + 2.5 * beat, s, 0.22)
                put(buf_r, t0 + 2.5 * beat, s, 0.22)
            if rng.random() < 0.5:
                h = hat(0.05, bright=False)
                put(buf_l, t0 + k * beat + beat / 2, h, 0.10)
                put(buf_r, t0 + k * beat + beat / 2, h, 0.14)
    return buf_l, buf_r

# ─────────────────────────────────────────────────────────────
# STYLE 3: DANCE (124 BPM, four-on-the-floor)
# ─────────────────────────────────────────────────────────────
def make_dance(seed, bars=40):
    rng = np.random.default_rng(seed)
    bpm = 124
    beat = 60 / bpm
    dur = bars * 4 * beat + 2
    buf_l = np.zeros(int(SR * dur))
    buf_r = np.zeros(int(SR * dur))
    roots = [-12, -10, -15, -8]  # A, B, F, C
    for bar in range(bars):
        t0 = bar * 4 * beat
        root = roots[bar % 4]
        drop = bar >= 4  # first 4 bars: intro without kick
        # four-on-the-floor kick
        if drop:
            for k in range(4):
                kk = kick(0.30)
                put(buf_l, t0 + k * beat, kk, 0.8)
                put(buf_r, t0 + k * beat, kk, 0.8)
        # off-beat hats
        for k in range(8):
            h = hat(0.07, bright=True)
            put(buf_l, t0 + (k + 0.5) * beat / 2, h, 0.30)
            put(buf_r, t0 + (k + 0.5) * beat / 2, h, 0.30)
        # driving sixteenth bass (octave jumps)
        for k in range(16):
            oct_up = k % 4 == 2
            bf = note_freq(root - 24 + (12 if oct_up else 0))
            b = bass_note(bf, beat * 0.22, amp=0.44, alpha=0.22)
            put(buf_l, t0 + k * beat / 4, b, 0.9)
            put(buf_r, t0 + k * beat / 4, b, 0.9)
        # bright arp
        if bar % 2 == 0 or drop:
            for k in range(8):
                deg = AMIN_PENT[rng.integers(0, 5)] + 12
                af = note_freq(root + deg)
                a = pluck(af, beat * 0.45, amp=0.17, bright=0.4)
                put(buf_l, t0 + k * beat / 2, a, 0.7)
                put(buf_r, t0 + k * beat / 2, a, 0.7)
        # superpad on 2 and 4
        for k in (1, 3):
            freqs = [note_freq(root + iv) for iv in [0, 3, 7]]
            p = pad_chord(freqs, beat * 0.9, amp=0.16, alpha=0.2)
            put(buf_l, t0 + k * beat, p, 0.8)
            put(buf_r, t0 + k * beat, p, 0.8)
        # snare on 2 and 4 (after the drop)
        if drop:
            for k in (1, 3):
                s = snare(0.15)
                put(buf_l, t0 + k * beat, s, 0.45)
                put(buf_r, t0 + k * beat, s, 0.45)
    return buf_l, buf_r

TRACKS = [
    ("synthwave_neon_rain",   make_synthwave, 11,  "Neon rain",      "synthwave"),
    ("synthwave_midnight",    make_synthwave, 23,  "Midnight drive", "synthwave"),
    ("synthwave_outrun",      make_synthwave, 37,  "Outrun airport", "synthwave"),
    ("lofi_study_room",       make_lofi,      51,  "Reading room on Moon street", "lofi"),
    ("lofi_rainy_window",     make_lofi,      67,  "Rain outside the window",     "lofi"),
    ("lofi_slow_morning",     make_lofi,      83,  "Slow morning",   "lofi"),
    ("dance_pulse_floor",     make_dance,     91,  "Pulse dancefloor", "dance"),
    ("dance_neon_bass",       make_dance,     107, "Neon bass",      "dance"),
    ("dance_afterglow",       make_dance,     131, "Afterglow",      "dance"),
]

def main():
    parser = argparse.ArgumentParser(description="HUK procedural seed-content generator")
    parser.add_argument(
        "--out",
        default="seed-audio",
        help="output directory (default: seed-audio/)",
    )
    args = parser.parse_args()
    out_dir = args.out
    os.makedirs(out_dir, exist_ok=True)

    manifest = []
    for slug, maker, seed, title, style in TRACKS:
        print(f"[*] {title} ({slug})")
        L, R = maker(seed)
        finalize(L, R, f"{out_dir}/{slug}.wav", f"{out_dir}/{slug}.mp3")
        manifest.append({
            "slug": slug,
            "file": f"{slug}.mp3",
            "title": title,
            "style": style,
        })

    with open(f"{out_dir}/manifest.json", "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print("DONE")

if __name__ == "__main__":
    main()
