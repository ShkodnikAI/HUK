# ADR-0001 — Rewrite instead of refactor the prototype
Status: Accepted (2026-10-06)

Context: prototype v0.2.1 has ~2.5k lines of custom code (the rest is generated UI kit), stores user audio on
disk, advances the timeline inside GET requests, has no accounts, and exposes unauthenticated moderation
endpoints and a moderation bypass (`?mod=1`). Every pillar of the new design (accounts, sources, worker,
charts) changes the foundations.

Decision: start the application fresh on `main`; tag the old state `prototype-v0.2.1`; port only the sync
hook, visualizer, ffprobe checks and the procedural music generator (via `legacy/`).

Consequences: low sunk cost; history keeps old binaries (accepted, D7); the prototype must never be deployed publicly.
