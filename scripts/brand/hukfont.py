"""Helpers: glyph outlines from OFL fonts -> SVG path data (no font dependency in the output)."""
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen
import os
FD = os.environ.get("FONTSOURCE_DIR", "node_modules/@fontsource")

class Face:
    def __init__(self, family, weight, subsets=("latin", "cyrillic")):
        self.fonts = []
        for s in subsets:
            p = f"{FD}/{family}/files/{family}-{s}-{weight}-normal.woff"
            if os.path.exists(p):
                f = TTFont(p); self.fonts.append((f, f.getBestCmap(), f.getGlyphSet(), f["head"].unitsPerEm))
        self.upem = self.fonts[0][3]

    def _find(self, ch):
        for f, cmap, gs, upem in self.fonts:
            if ord(ch) in cmap: return f, cmap[ord(ch)], gs, upem
        raise KeyError(ch)

    def advance(self, ch):
        f, gn, gs, upem = self._find(ch); return gs[gn].width / upem

    def bounds(self, ch):
        f, gn, gs, upem = self._find(ch)
        bp = BoundsPen(gs); gs[gn].draw(bp)
        b = bp.bounds; return tuple(v / upem for v in b)  # in em units, y up

    def cap_height(self):
        return self.bounds("H")[3]

    def path(self, ch, size, x, y):
        """SVG path data of one glyph, baseline-left at (x,y), size in px per em (y flipped)."""
        f, gn, gs, upem = self._find(ch)
        sp = SVGPathPen(gs, ntos=lambda v: f"{v:.2f}".rstrip("0").rstrip("."))
        s = size / upem
        gs[gn].draw(TransformPen(sp, (s, 0, 0, -s, x, y)))
        return sp.getCommands()

    def text(self, s, size, x, y, tracking=0.0, anchor="start"):
        """Returns (path_d, total_width_px). tracking in em. Kerning ignored (caps, wide tracking)."""
        adv = [self.advance(c) * size + tracking * size for c in s]
        total = sum(adv) - tracking * size
        x0 = x - (total if anchor == "end" else total / 2 if anchor == "middle" else 0)
        d, cx = [], x0
        for c, a in zip(s, adv):
            if c != " ": d.append(self.path(c, size, cx, y))
            cx += a
        return " ".join(d), total
