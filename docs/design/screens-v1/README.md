# HUK screens v1 (Owner-approved design reference)

Approved by the Owner on 2026-10-09 (`hukradio.com` bought the same day). These are the source files of the design
canvas "HUK - Screens v1": one `*.dc.html` file per screen ("board") plus `canvas.json` (board sizes and order) and
`TOKENS.md` (the palette, type and spacing extracted from the boards).

## How to use

- The boards are **reference, not code to ship**. Read them for layout, copy, states and colour; build the real thing
  with the project's stack (Next.js, Tailwind, next-intl). Do not copy the inline styles or the `support.js` runtime
  (the latter is not in the repository, so the files do not render on their own; open them as text).
- Phone boards are 390 px wide, desktop boards 1280 px. Tap targets are at least 44 px.
- Text in `[square brackets]` is a **placeholder for content that is not decided** (legal wording, DMCA contact,
  limits, sample data). Never ship a bracket to production: either wire real data or leave the element out.
- `BRAND.md` wins over a board when they disagree (for example the wordmark "UK" grey is `#7A7B80` there).
- The light theme is not designed (palette unconfirmed, `BRAND.md` section 3). Dark only.
- Dislikes are private everywhere: no screen shows a dislike count, not even to the artist.

## Boards

| Board | File | Notes |
|---|---|---|
| Radio (now playing), phone | `Main.dc.html` | includes the comment ticker (latest approved comments, plain text) |
| Charts | `Charts.dc.html` | |
| Track page | `Track.dc.html` | declared-by block, optional lyrics, comments |
| My playlists | `Playlists.dc.html` | |
| Search | `Search.dc.html` | |
| Account and data | `Account.dc.html` | export and deletion |
| Sign in | `SignIn.dc.html` | emailed link only, no passwords |
| Check your email | `CheckEmail.dc.html` | |
| Invite code | `Invite.dc.html` | artists only; listeners do not need a code |
| Submit a track | `Submit.dc.html` | includes optional lyrics |
| Artist cabinet | `Cabinet.dc.html` | statuses in words, stats are placeholders |
| Artist profile | `Profile.dc.html` | links from the approved list only |
| You are leaving HUK | `Leaving.dc.html` | interstitial for every external link |
| Report a track | `Report.dc.html` | |
| Quiet, offline, not found | `States.dc.html` | |
| Desktop radio / charts | `DesktopRadio.dc.html`, `DesktopCharts.dc.html` | |
| Moderator queue | `ModQueue.dc.html` | |
| Admin: invites | `Admin.dc.html` | **known mismatch:** the board offers "Listener account" as a grant; invites are for artists only (listeners need no code) |
| How charts work | `HowCharts.dc.html` | numbers must match `src/server/ranking/signals.ts` |

Implementation is split into naryads (see `docs/PLAN.md`); each naryad lists the boards it implements.
