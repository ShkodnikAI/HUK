# Legal posture and questions for counsel

Not legal advice. This lists what the design assumes and what a lawyer must confirm.

## Design assumptions
- Non-commercial, free, no ads; donations go to the developer for the software, not for the station or tracks.
- Authors keep and host their files; HUK links and streams from the source. A licence from each author for display/playback (radio, optionally on-demand playlists) is recorded at submission (`Consent`, `licenseScope`).
- Takedown within hours; region restriction for country-specific legal orders; repeat-infringer policy; public contact.
- Authors declare AI tool and plan at creation time; free-tier outputs of some generators are restricted to personal non-commercial use, so the author warranty and a clear ToS matter.

## Questions for counsel
1. Operator status and liability exposure for an individual operator vs an entity; which jurisdiction to anchor (EU/US/other).
2. Intermediary/safe-harbour position of a *curated radio* (editorial scheduling) vs a passive host; need for DSA legal representative/contact; applicability of notice-and-action and statement-of-reasons duties to our size.
3. DMCA agent designation and counter-notice flow; EU equivalents.
4. Collective-management organisations: should authors who are members of a PRO/CMO be excluded from uploading?
5. Is a donation page for the developer sufficiently separate from the station for non-commercial licence terms (generator ToS, AcoustID)?
6. GDPR: lawful bases, retention schedule in `ARCHITECTURE.md` §4, rotating-salt IP hashing, international transfers, children's age gate, deletion/export.
7. Belarus-specific: obligations (if any) for operators located in Belarus; treatment of legal removal requests from any state; user-protection language for Belarusian users.
8. ToS clauses: warranties, indemnity limits for consumers, licence scope, moderation rights, appeal path, governing law, translation precedence (English).
9. AI transparency: labelling of AI-generated tracks and any EU AI Act duties relevant to us as deployer of moderation models.
10. Moderation policy wording and removal grounds (policy/moderation-policy.md).
