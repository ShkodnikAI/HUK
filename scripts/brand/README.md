# Brand asset generator

Rebuilds the logo set in `docs/assets/brand/` from open fonts. The fonts are converted to outlines, so the
outputs contain no font files and no font dependency.

```bash
npm i --no-save @fontsource/cormorant-garamond @fontsource/inter     # SIL OFL 1.1 fonts
pip install fonttools cairosvg pillow
FONTSOURCE_DIR=node_modules/@fontsource python3 scripts/brand/make_assets.py docs/assets/brand
```

- `hukfont.py` glyph outlines to SVG path data (Latin and Cyrillic subsets).
- `build.py` the H with a waveform crossbar, wordmark, spaced text helpers, colour tokens.
- `make_assets.py` lockups, icons, banner, Open Graph image, favicon set.

Colour tokens and rules: `docs/BRAND.md`. Change a token in `build.py` or `make_assets.py`, rerun, commit the outputs.
