# ADR-0002 — Authors keep audio; HUK stores links and hashes
Status: Accepted

Context: the platform is free and non-commercial; storing and serving user audio multiplies cost and legal exposure.

Decision: tracks are referenced via `TrackSource` (Audius or author-hosted HTTPS URL). Clients stream directly
from the source. We fetch a file transiently for moderation, store `contentHash/etag/byteLength`, and re-verify
periodically; mismatch suspends the track. Only generated seed music is hosted by us.

Consequences: no audio hosting cost; reliability depends on authors' hosts (skip + `available=false`); CORS
limits visualizers (visualizer degrades gracefully); a licence from the author is still required (consent record).
