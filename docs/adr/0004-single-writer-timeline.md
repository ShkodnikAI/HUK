# ADR-0004 — Timeline owned by a single worker; `/now` is a pure read
Status: Accepted

Context: the prototype advanced state on whichever request arrived first, under an in-process mutex, which
cannot scale or be cached.

Decision: a worker process holds a Postgres advisory lock and is the only writer of `BroadcastSlot`. The API
only reads. `/api/radio/now` returns identical data for all listeners and is cached 2–3 s at the edge.

Consequences: two workers started → one idles; worker downtime stops new slots (health check alerts) but
already-scheduled slots keep playing; timeline math is pure and property-tested.
