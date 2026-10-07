import sys, random, math
sys.path.insert(0, "/tmp/brand")
from hukfont import Face
from fontTools.pens.pointInsidePen import PointInsidePen

GOLD, GREY, TAG, BG, BG_EDGE = "#D4AF37", "#7A7B80", "#8B8C8E", "#1A1B1F", "#121315"
SERIF = Face("cormorant-garamond", "500")
SANS = Face("inter", "500")
SANS_L = Face("inter", "400")

def f2(v): return f"{v:.2f}".rstrip("0").rstrip(".")

def h_geometry(face):
    """Scan the H outline (em units, y up): stem inner edges and crossbar band."""
    f, gn, gs, upem = face._find("H")
    xmin, ymin, xmax, ymax = face.bounds("H")
    def inside(x, y):
        p = PointInsidePen(gs, (x * upem, y * upem)); gs[gn].draw(p); return p.getResult()
    # row above the crossbar -> stems
    y_row = ymax * 0.82
    xs = [xmin + i * (xmax - xmin) / 1500 for i in range(1501)]
    on = [inside(x, y_row) for x in xs]
    ivals, start = [], None
    for x, o in zip(xs, on):
        if o and start is None: start = x
        if not o and start is not None: ivals.append((start, x)); start = None
    if start is not None: ivals.append((start, xs[-1]))
    assert len(ivals) == 2, ivals
    # column at centre -> crossbar band
    cx = (xmin + xmax) / 2
    ys = [ymin + i * (ymax - ymin) / 1500 for i in range(1501)]
    oy = [inside(cx, y) for y in ys]
    yin = [y for y, o in zip(ys, oy) if o]
    return dict(xmin=xmin, xmax=xmax, ymin=ymin, ymax=ymax,
                ix0=ivals[0][1], ix1=ivals[1][0], by0=min(yin), by1=max(yin), stemL=ivals[0], stemR=ivals[1])

def wave_path(cx, cy, inner_w, max_h, n=19, bar_w=2.0, seed=7, fill_ratio=0.8):
    """Symmetric-ish audio waveform as rect subpaths centred on (cx,cy)."""
    rnd = random.Random(seed)
    pitch = inner_w * fill_ratio / (n - 1)
    d = []
    for i in range(n):
        t = (i - (n - 1) / 2) / ((n - 1) / 2)          # -1..1
        env = math.exp(-(t / 0.55) ** 2)               # bell envelope
        h = max_h * (0.10 + 0.90 * env * (0.55 + 0.45 * rnd.random()))
        if i == (n - 1) // 2: h = max_h                 # tallest centre bar
        x = cx + (i - (n - 1) / 2) * pitch - bar_w / 2
        d.append(f"M{f2(x)} {f2(cy - h / 2)}h{f2(bar_w)}v{f2(h)}h{f2(-bar_w)}z")
    return "".join(d)

def h_mark(face, cap, x, base, fill, line_w=2.0, bar_w=2.0, n=19, uid="hc", max_h_ratio=0.60):
    """H glyph with the crossbar replaced by a waveform. Returns (svg, advance_px, geometry_px)."""
    g = h_geometry(face); size = cap / face.cap_height(); s = size
    X = lambda u: x + u * s
    Y = lambda v: base - v * s
    path = face.path("H", size, x, base)
    pad = 0.05 * s
    bx0, bx1, by0, by1 = X(g["ix0"]) + 0.4, X(g["ix1"]) - 0.4, Y(g["by1"]) - 0.5, Y(g["by0"]) + 0.5
    fx0, fx1, fy0, fy1 = X(g["xmin"]) - 5, X(g["xmax"]) + 5, Y(g["ymax"]) - 5, Y(g["ymin"]) + 5
    # clip = everything EXCEPT the crossbar band between the stems, built from 4 plain rectangles (no evenodd: portable)
    def R(x0, y0, x1, y1): return f"M{f2(x0)} {f2(y0)}H{f2(x1)}V{f2(y1)}H{f2(x0)}Z"
    clip = (f'<clipPath id="{uid}"><path d="' + R(fx0, fy0, fx1, by0) + R(fx0, by1, fx1, fy1)
            + R(fx0, by0, bx0, by1) + R(bx1, by0, fx1, by1) + '"/></clipPath>')
    cy = (by0 + by1) / 2
    over = 0.02 * (X(g["xmax"]) - X(g["xmin"]))
    line = f'<rect x="{f2(X(g["xmin"]) - over)}" y="{f2(cy - line_w / 2)}" width="{f2(X(g["xmax"]) - X(g["xmin"]) + 2 * over)}" height="{f2(line_w)}"/>'
    wave = wave_path((bx0 + bx1) / 2, cy, bx1 - bx0, cap * max_h_ratio, n=n, bar_w=bar_w)
    svg = (f'<defs>{clip}</defs><g fill="{fill}"><path clip-path="url(#{uid})" d="{path}"/>{line}<path d="{wave}"/></g>')
    adv = face.advance("H") * size
    return svg, adv, dict(x0=X(g["xmin"]), x1=X(g["xmax"]), top=Y(g["ymax"]), cy=cy, base=base)

def wordmark(cap, x, base, gold=GOLD, grey=GREY, tracking=0.06, uid="hc", n=19, bar_w=2.0, line_w=2.0, face=SERIF):
    """HUK wordmark with its left edge at x. Returns (svg, width)."""
    size = cap / face.cap_height()
    hs, adv, geo = h_mark(face, cap, x, base, gold, uid=uid, n=n, bar_w=bar_w, line_w=line_w)
    cx = x + adv + tracking * size
    d, w = face.text("UK", size, cx, base, tracking=tracking)
    return hs + f'<path fill="{grey}" d="{d}"/>', (cx + w) - x

def spaced(face, text, cap, cx, base, fill, tracking=0.34, anchor="middle"):
    size = cap / face.cap_height()
    d, w = face.text(text, size, cx, base, tracking=tracking, anchor=anchor)
    return f'<path fill="{fill}" d="{d}"/>', w

def svg_doc(w, h, body, bg=None, title="HUK", desc=""):
    bgrect = bg or ""
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {f2(w)} {f2(h)}" width="{f2(w)}" height="{f2(h)}" role="img" aria-labelledby="t d">'
            f'<title id="t">{title}</title><desc id="d">{desc}</desc>{bgrect}{body}</svg>')
