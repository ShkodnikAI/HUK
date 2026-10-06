# Owner decisions (open)

Each item blocks the naryads listed. Recommendations are the Auditor's, not decisions.

| ID | Decision | Recommendation | Blocks |
|---|---|---|---|
| D1 | Lawyer review of ToS/Privacy and operator legal status (individual vs foreign entity; Belarus exposure of an individual operator) | Do before any public launch; prepare questions from `docs/LEGAL.md` | H-404, H-506 |
| D2 | Moderation and link policy (default: blatant crime + nastiness only; external links off except whitelist; how to treat legal removal requests per country) | Approve `policy/moderation-policy.md`; use region restriction rather than global removal for country-specific orders | H-204, H-401, H-206 |
| D3 | Audius as a primary source: verify its API terms for AI music and radio-style use | Verify before building on it; keep DIRECT_URL as equal path | H-202, H-506 |
| D4 | Hosting provider and payment channel (Belarusian cards are rejected by many foreign hosts; provider terms vary) | Pick a provider that accepts the owner's legitimate payment method; avoid workarounds that violate provider terms | H-504 |
| D5 | Donation channel for the developer (not for the station) and whether AcoustID's "non-commercial" free tier still fits | Keep donation page separate from the player; ask the AcoustID maintainers if unsure | H-205, H-404 |
| D6 | Public contact + DMCA agent designation (needs a named agent/address) | Use a role mailbox; consider a registered agent service | H-206, H-506 |
| D8 | Project name: "HUK" is an overloaded term (hardware unique key, other projects) | Decide before public launch; cheap to change now | H-506 |
| D9 | Documentation language (English chosen) | Keep English; UI via catalogs | — |
| D10 | First moderator(s) — the owner alone at the start? | Owner + invite-only beta keeps queue small | H-505 |

## Decided

| ID | Decision | Resolution | Date |
|---|---|---|---|
| D7 | Git history: keep prototype history (23 MB of audio + a DB in history) or start a fresh repository | Fresh `main`; the prototype is preserved as the annotated tag `prototype-v0.2.1` (commit `24d0c33`). Audio and SQLite remain in tag history only, never on `main`. No force-push. H-001 done-criteria verified against the working tree (`git ls-files`: no binary > 1 MB, no `*.db`). | 2026-10-06 |
| D11 | Merge authority for the full naryad cycle | The Owner delegated merging to the Agent (chat decision). Gate: all blocking CI jobs green on the merge commit; report per AGENTS §10; acceptance discipline (AGENTS §6.6) unchanged; Auditor review at wave gates. AGENTS §0 aligned. | 2026-10-06 |
