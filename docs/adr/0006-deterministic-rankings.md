# ADR-0006 — Rankings are deterministic (Wilson + decay); AI audits
Status: Accepted

Decision: chart scores are the Wilson lower bound over time-decayed, reputation-weighted signals (likes,
hidden dislikes, playlist adds, completion, early skips) with a minimum of 10 distinct voters. Exploration for
fresh tracks uses Thompson sampling in scheduler quota only. AI detects anomalies and reviews content but never
sets chart positions. Dislikes are never public and never auto-remove a track.

Consequences: explainable and testable; small-data friendly; personalisation (Gorse) deferred until enough
interaction data exists (phase 6).
