#!/usr/bin/env python3
"""Generate the HUK logo set (SVG + PNG) from open fonts. Usage: python3 make_assets.py <out_dir>
Needs: fonttools, cairosvg, Pillow; fonts via npm: @fontsource/cormorant-garamond, @fontsource/inter (SIL OFL 1.1).
Set FONTSOURCE_DIR to node_modules/@fontsource. Outputs are plain outlines: no font files are shipped."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build import *
import cairosvg
from PIL import Image
import io

OUT = sys.argv[1]; os.makedirs(os.path.join(OUT, "icons"), exist_ok=True)
GOLD_L, CHAR_L, TAG_L = "#8C6D14", "#3B3C41", "#6B6C70"          # light-theme proposal
DESC = "FREE INTERNET RADIO"; TAGLINE = "FEEL EVERY FREQUENCY."

def lum(h):
    c = [int(h[i:i+2], 16) / 255 for i in (1, 3, 5)]
    f = lambda v: v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])
def cr(a, b):
    x, y = sorted([lum(a), lum(b)], reverse=True); return (x + .05) / (y + .05)

def write(name, text): open(os.path.join(OUT, name), "w", encoding="utf-8").write(text)

def lockup(cap, gold=GOLD, grey=GREY, tag=TAG, uid="h", full=True, desc_only=False):
    """Primary lockup, origin top-left. Returns (body, W, H)."""
    pad = 0.05 * cap
    wm, w = wordmark(cap, pad, cap + 0.02 * cap, gold=gold, grey=grey, uid=uid)
    W = w + 2 * pad; cx = W / 2; base = cap + 0.02 * cap
    body = wm
    dcap = 0.11 * cap; dbase = base + 0.42 * cap
    d_svg, wd = spaced(SANS, DESC, dcap, cx, dbase, gold, tracking=0.34)
    gap, L, ry = 0.14 * cap, 0.43 * cap, dbase - dcap / 2
    rules = (f'<rect x="{f2(cx - wd/2 - gap - L)}" y="{f2(ry - 0.5)}" width="{f2(L)}" height="1" fill="{gold}"/>'
             f'<rect x="{f2(cx + wd/2 + gap)}" y="{f2(ry - 0.5)}" width="{f2(L)}" height="1" fill="{gold}"/>')
    body += d_svg + rules; H = dbase + 0.08 * cap
    if full:
        tcap = 0.075 * cap; tbase = dbase + 0.25 * cap
        t_svg, _ = spaced(SANS_L, TAGLINE, tcap, cx, tbase, tag, tracking=0.30)
        body += t_svg; H = tbase + 0.08 * cap
    return body, W, H

def stacked(cap, gold=GOLD, grey=GREY, tag=TAG, uid="hs"):
    g = h_geometry(SERIF); size = cap / SERIF.cap_height(); pad = 0.1 * cap
    W = 2.9 * cap + 2 * pad; cx = W / 2
    x = cx - (g["xmin"] + g["xmax"]) / 2 * size
    base1 = pad + cap
    hs, _, _ = h_mark(SERIF, cap, x, base1, gold, uid=uid, n=19)
    base2 = base1 + 1.30 * cap
    uk, _ = SERIF.text("UK", size, cx, base2, tracking=0.10, anchor="middle")
    body = hs + f'<path fill="{grey}" d="{uk}"/>'
    dcap, dbase = 0.11 * cap * 0.8, base2 + 0.42 * cap * 0.9
    d_svg, wd = spaced(SANS, DESC, dcap, cx, dbase, gold, tracking=0.34)
    gap, L, ry = 0.14 * cap, 0.30 * cap, dbase - dcap / 2
    body += d_svg + (f'<rect x="{f2(cx - wd/2 - gap - L)}" y="{f2(ry-.5)}" width="{f2(L)}" height="1" fill="{gold}"/>'
                     f'<rect x="{f2(cx + wd/2 + gap)}" y="{f2(ry-.5)}" width="{f2(L)}" height="1" fill="{gold}"/>')
    t_svg, _ = spaced(SANS_L, TAGLINE, 0.075 * cap * 0.8, cx, dbase + 0.22 * cap, tag, tracking=0.30)
    return body + t_svg, W, dbase + 0.22 * cap + 0.12 * cap

def icon_ring():
    cap = 250; g = h_geometry(SERIF); size = cap / SERIF.cap_height()
    x = 256 - (g["xmin"] + g["xmax"]) / 2 * size; base = 256 + cap / 2
    hs, _, _ = h_mark(SERIF, cap, x, base, GOLD, uid="hi", n=15, bar_w=4.2, line_w=4.0)
    return (f'<circle cx="256" cy="256" r="254" fill="{BG}"/><circle cx="256" cy="256" r="232" fill="none" stroke="{GOLD}" stroke-width="7"/>' + hs)

def icon_small(rounded=True, content_scale=1.0):
    """Bold geometric H with a 3-bar waveform; legible at 16 px. 512 canvas."""
    k = content_scale; c = 256
    T = lambda v: c + (v - c) * k
    def rect(x, y, w, h): return f"M{f2(T(x))} {f2(T(y))}h{f2(w*k)}v{f2(h*k)}h{f2(-w*k)}z"
    d = rect(104, 128, 56, 256) + rect(352, 128, 56, 256)                       # stems
    d += rect(160, 247, 192, 18)                                                  # crossbar line (stem to stem)
    d += rect(183, 196, 26, 120) + rect(243, 140, 26, 232) + rect(303, 196, 26, 120)  # 3 bars, clear of the stems
    bg = f'<rect width="512" height="512" rx="112" fill="{BG}"/>' if rounded else f'<rect width="512" height="512" fill="{BG}"/>'
    return bg + f'<path fill="{GOLD}" d="{d}"/>'

def gradient_bg(w, h, uid="g"):
    return (f'<defs><radialGradient id="{uid}" cx="50%" cy="50%" r="75%"><stop offset="0" stop-color="{BG}"/>'
            f'<stop offset="1" stop-color="{BG_EDGE}"/></radialGradient></defs><rect width="{w}" height="{h}" fill="url(#{uid})"/>')

def centered(body, W, H, cw, ch):
    return f'<g transform="translate({f2((cw - W) / 2)} {f2((ch - H) / 2)})">{body}</g>'

def png(svg, name, w=None, h=None):
    cairosvg.svg2png(bytestring=svg.encode(), write_to=os.path.join(OUT, name), output_width=w, output_height=h)

DESCR = "HUK: the letter H carries an audio waveform as its crossbar"
# --- wordmarks
cap = 200; pad = 0.07 * cap
for name, gold, grey, uid in [("huk-wordmark.svg", GOLD, GREY, "w1"), ("huk-wordmark-light.svg", GOLD_L, CHAR_L, "w2"), ("huk-wordmark-mono.svg", "#000000", "#000000", "w3")]:
    wm, w = wordmark(cap, pad, cap + 6, gold=gold, grey=grey, uid=uid)
    write(name, svg_doc(w + 2 * pad, cap + 12 + 6, wm, title="HUK", desc=DESCR))
# --- lockups
for name, kw, uid in [("huk-lockup-primary.svg", {}, "p1"), ("huk-lockup-primary-light.svg", dict(gold=GOLD_L, grey=CHAR_L, tag=TAG_L), "p2")]:
    b, W, H = lockup(200, uid=uid, **kw); write(name, svg_doc(W, H, b, title="HUK: free internet radio", desc=DESCR))
b, W, H = lockup(200, uid="p3", full=False); write("huk-lockup-horizontal.svg", svg_doc(W, H, b, title="HUK: free internet radio", desc=DESCR))
b, W, H = stacked(140); write("huk-lockup-stacked.svg", svg_doc(W, H, b, title="HUK: free internet radio", desc=DESCR))
# --- icons
write("huk-icon.svg", svg_doc(512, 512, icon_ring(), title="HUK icon", desc=DESCR))
write("huk-icon-small.svg", svg_doc(512, 512, icon_small(), title="HUK small icon", desc=DESCR))
# --- banner + og
b, W, H = lockup(150, uid="b1"); s = 1.0
banner = svg_doc(960, 390, gradient_bg(960, 390, "gb") + centered(b, W, H, 960, 390), title="HUK: free internet radio", desc=DESCR)
write("huk-banner.svg", banner); png(banner, "huk-banner.png", 1920, 780)
b, W, H = lockup(190, uid="o1")
og = svg_doc(1200, 630, gradient_bg(1200, 630, "go") + centered(b, W, H, 1200, 630), title="HUK: free internet radio", desc=DESCR)
png(og, "og-image.png", 1200, 630)
# --- PNG icons
small = svg_doc(512, 512, icon_small(True), title="HUK")
png(small, "icons/icon-192.png", 192, 192); png(small, "icons/icon-512.png", 512, 512)
for n in (16, 32, 48): png(small, f"icons/favicon-{n}.png", n, n)
png(svg_doc(512, 512, icon_small(False, 0.80), title="HUK"), "icons/icon-maskable-512.png", 512, 512)   # content inside the 80% safe zone
png(svg_doc(512, 512, icon_small(False, 0.80), title="HUK"), "icons/apple-touch-icon-180.png", 180, 180)
imgs = [Image.open(os.path.join(OUT, f"icons/favicon-{n}.png")).convert("RGBA") for n in (48, 32, 16)]
imgs[0].save(os.path.join(OUT, "icons/favicon.ico"), sizes=[(48, 48), (32, 32), (16, 16)], append_images=imgs[1:])
print("contrast (light theme on white): gold %.2f  charcoal %.2f  tagline %.2f" % (cr(GOLD_L, "#FFFFFF"), cr(CHAR_L, "#FFFFFF"), cr(TAG_L, "#FFFFFF")))
print("contrast (dark theme on %s): gold %.2f  grey %.2f  tagline %.2f" % (BG, cr(GOLD, BG), cr(GREY, BG), cr(TAG, BG)))
