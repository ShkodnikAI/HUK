# Tokens extracted from the boards (v1, dark only)

Counts are how often a value appears across all boards. Use these as CSS variables in `src/app/globals.css`
(Tailwind v4 `@theme`), named by role, not by value.

## Colour

| Role | Value | Notes |
|---|---|---|
| Background | `#1A1B1F` | page |
| Surface | `#23242A` | cards, inputs on a card |
| Surface sunken | `#1F2025` | form fields, bottom navigation |
| Surface raised | `#2C2D34` | chips, active tab, dividers inside lists |
| Border | `#34353C` | card and field borders |
| Text | `#ECEBE6` | body |
| Text muted | `#A3A4A9` | secondary text, labels |
| Gold | `#D4AF37` | brand, primary button background (dark text on it), links, focus accent |
| Gold tint | `#3A3217` | "in review" / "paused" badge background |
| Success | text `#7FC8A9` on `#1F3A30` | "on air", "redeemed" |
| Danger | text `#E58B84` on `#3B2523` | "not accepted", "removed" |
| Wordmark "UK" | `#7A7B80` | from `BRAND.md` (the boards use `#8B8C8E`, which is the tagline grey; `BRAND.md` wins) |
| Tagline grey | `#8B8C8E` | small tagline text |

Every status is shown with a **word as well as a colour** (accessibility rule of the design).
Contrast must be checked, not assumed: the naryad that introduces the tokens verifies AA for each text and
background pair it uses and records the result in the PR.

## Type

- UI: Inter 400, 500, 600. Body 14 to 15 px, labels 12 to 13 px, small captions 11 to 12 px.
- Display: Cormorant Garamond 500 to 600, **only** for the wordmark and large screen titles (34 to 48 px).
- Self-host the fonts (no third-party font request from the page; S7 minimal data about people).

## Shape and spacing

- Radius: 12 px fields and buttons, 14 px cards, 20 px hero card, 22 px pills.
- Phone gutter 20 px. Minimum tap target 44 px; primary buttons 48 to 52 px.
- Desktop content width 960 to 1100 px, centred.
- Motion: the comment ticker is the only continuous animation; it pauses on hover, focus and touch and is static under
  `prefers-reduced-motion`.
