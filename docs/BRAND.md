# HUK — Brand guide (v0, derived from the logo board)

Status: **concept stage.** Everything below is read from one raster board
(`docs/assets/brand/huk-brand-board.jpg`, JPEG; the original is 960 × 960). Vector masters do not exist yet (see §8).
Values marked *measured* were sampled from the JPEG (median of thresholded pixels), not taken from source files.

## 1. Name

**HUK** (Latin) / `ГУК` (Cyrillic). In Belarusian `гук` means "sound". The board contains only the Latin
wordmark; a Cyrillic lockup is not designed yet. The name is an overloaded term elsewhere (owner decision D8).

## 2. Logo anatomy

- **Wordmark:** three capitals in a high-contrast serif with hairline serifs.
- **The idea:** the letter **H** is gold and its crossbar is replaced by an audio waveform; the baseline of the wave
  extends slightly past both stems. **UK** is set in charcoal grey. Gold = the sound, grey = the rest.
- **Descriptor line:** `MUSIC STREAMING` in gold, wide-tracked caps, flanked by two thin rules.
- **Tagline:** `FEEL EVERY FREQUENCY.` in grey, small wide-tracked caps.

## 3. Lockups on the board

| Lockup | Composition | Use |
|---|---|---|
| Primary | wordmark + descriptor + tagline | hero areas, README banner, OG image |
| Horizontal | wordmark + descriptor + tagline, compact | headers, documents |
| Stacked | `H` (with wave) over `UK`, then descriptor | square-ish placements |
| Icon / app mark | `H` with wave inside a thin gold circle | avatar, PWA icon, favicon (needs simplification, §6) |

A third line appears under the icon: `SOUND. FEELING. CONNECTION.` (secondary tagline, not for the logo itself).

## 4. Colour

| Role | Label on the board | Measured | Notes |
|---|---|---|---|
| Gold | `#D4AF37` | `#CBA361` (H), `#B79051` (swatch) | the logo renders as a muted champagne gradient, not flat `#D4AF37` |
| "Charcoal" | `#1E1E1E` | `#606165` ("UK"), `#525358` (swatch) | **label and swatch disagree** |
| Background | — | `#121315` (corner) … `#1A1B1F` (centre) | dark vignette gradient |

Contrast on the board background `#1A1B1F` (WCAG 2.x):

| Colour | Ratio | Verdict |
|---|---|---|
| Gold `#D4AF37` | 8.18:1 | passes everything |
| Gold as rendered `#CBA361` | 7.33:1 | passes |
| "UK" grey as rendered `#606165` | **2.78:1** | fails the 3:1 minimum for large text and graphics |
| Tagline grey `#8B8C8E` | 5.11:1 | passes for small text |
| Label `#1E1E1E` | 1.03:1 | it is the background colour, not a visible grey |

Proposed (not applied): keep gold `#D4AF37` as the token; use `#7A7B80` (4.07:1) or lighter for the "UK" grey,
`#8B8C8E` for small tagline text; background `#1A1B1F`. **Owner confirms the canonical hex values** (§9).
On white, gold is only 2.10:1: a light-theme variant (dark gold or charcoal wordmark) is required before any light surface.

## 5. Typography

Observed, not identified (no font files were supplied):

- **Logotype:** high-contrast serif capitals (didone/transitional style), hairline serifs.
- **Descriptor/tagline:** light grotesque or geometric sans, all caps, very wide tracking (about 0.3 em).

Rule of thumb for the product: the serif is for the logotype and large display text only; UI text uses a neutral
sans. Any font chosen for the wordmark or UI must cover **Latin and Cyrillic** (the name has a Cyrillic form) and
have a licence that allows embedding; verify both when selecting.

## 6. Usage rules (proposed)

- Clear space: at least the width of the letter H on all sides.
- Minimum size: wordmark 120 px wide on screens. Below that use the icon mark: the hairline serifs and the thin wave
  vanish at small sizes. The icon needs a **simplified** wave (fewer, thicker bars) for 16–32 px.
- Do not recolour the H grey or the UK gold, add effects, stretch, or place the logo on busy backgrounds.
- Do not use the grey "UK" as text on dark surfaces without raising its contrast (§4).

## 7. Descriptor and tagline: product accuracy

`MUSIC STREAMING` describes an on-demand service. HUK is a free 24/7 **radio** with one shared timeline (playlists
exist but are secondary and per-track licensed, see `docs/LEGAL.md`). "Streaming" may also set wrong expectations
about rights and features. Candidates: `FREE INTERNET RADIO`, `24/7 RADIO`. Owner decision (§9).

## 8. Assets: present and missing

| Asset | Status |
|---|---|
| README banner (960 × 390 crop of the primary lockup) | present: `docs/assets/brand/huk-banner.jpg` |
| Brand board (reference) | present: `docs/assets/brand/huk-brand-board.jpg`, cropped to 960 × 940 to remove a stray grey smudge in the bottom-right corner of the original, which looks like a leftover generator watermark |
| Vector wordmark and icon mark (SVG) | **missing** |
| Monochrome and light-theme variants | **missing** |
| Favicon 16/32, PWA icons 192/512 and maskable 512 (safe zone about 80%) | **missing** (needed by H-105) |
| Open Graph image 1200 × 630 | **missing** |
| Cyrillic lockup | **missing** |

The README banner is a raster crop and will look soft on high-density screens until the vector masters exist.

## 9. Open questions for the Owner

1. Canonical gold and grey hex values (§4).
2. Descriptor and tagline wording (§7).
3. Who produces the vector masters and variants; request the original files from whoever or whatever made the board.
4. Provenance: if the board was produced with an AI image tool, check that tool's terms for brand and commercial use.
   A trademark filing also needs an original, distinctive mark (relates to D8).
