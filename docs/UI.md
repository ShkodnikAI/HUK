# HUK — UI rules (short)

The dark tokens, the app shell and the base components landed with H-120
(#91); the boards they follow live in `docs/design/screens-v1/`.

## Where the tokens are

`src/app/globals.css` is the ONLY file with brand hex values. Every role
from `docs/design/screens-v1/TOKENS.md` is a CSS variable there, mapped
into Tailwind v4 `@theme` by role (`bg-surface`, `text-muted`,
`border-border`, `bg-gold`, `text-success`, ...). Never write a hex in a
component or a page; `tests/ui/tokens.test.ts` fails when one appears in
the shell, the base components, the locale layout or the 404 page. Dark
only — there is no light theme.

## Adding a navigation item

1. Add the page under `src/app/[locale]/<key>/`.
2. Flip its `enabled` flag to `true` in `src/components/shell/nav.ts` —
   the ONE config for both the desktop top bar and the phone bottom bar.
   An item whose page does not exist is not rendered.
3. Add the label to `messages/en.json` and `messages/ru.json` under `nav`
   (both catalogs must stay key-identical — a test enforces it).

## Rules

- **No colour-only status.** Every status carries a word as well as a
  colour (use `StatusBadge`; `children` is the word and is required).
- **No bracketed placeholder ships.** Text in `[square brackets]` on the
  design boards marks undecided content — wire real data or leave the
  element out.
- **No third-party request from the page.** Fonts are self-hosted via
  `next/font`; no external CSS, script, image or font host at runtime.
- **44 px is the floor.** Buttons, nav links and every interactive target
  carry `min-h-[44px]`/`min-w-[44px]` (primary buttons 48 px).
- **Gold focus.** Every interactive element gets the `focus-gold` class
  (visible gold focus ring for keyboard users).
- **The player never remounts.** The persistent player lives in the
  locale layout, outside `<main>`; pages never render their own
  `<audio>`.
