// H-306: the database time-zone mechanism.
//
// BroadcastSlot.startsAt/endsAt (and other schedule columns) are
// `timestamp(3) without time zone` storing UTC wall clock (Prisma writes
// them in UTC). PostgreSQL resolves a comparison between a naive column and
// a timestamptz parameter (or now()) THROUGH THE SESSION TIME ZONE, so on
// any database whose default zone is not UTC (a native install, a managed
// service) the radio reads its own slots as hours in the past and the
// station goes silent. CI and the compose `postgres:16` image run in UTC,
// which is why green CI never exercised this (found on the Owner's first
// local run, 2026-10-15, TimeZone = Europe/Minsk).
//
// The mechanism: every connection the app opens carries the PostgreSQL
// startup-packet run-time parameter `options=-c timezone=UTC`, which pins
// that session's time zone to UTC before the first query. It is applied at
// the single choke point every pooled Prisma connection comes from
// (src/server/db.ts) and to the scheduler's dedicated advisory-lock pg
// client (src/server/broadcast/scheduler.ts) — no other module opens a
// database connection (grep: `new PrismaClient` / `new Client` outside
// tests). The boot check (src/server/db-timezone.ts) verifies the effective
// zone on first use and refuses to start otherwise (S9, fail loud).
//
// Encoding note: query values are percent-encoded with %20 (RFC 3986), never
// the form-style `+` — connection-string parsers decode %XX octets but treat
// a literal `+` as data.

export const UTC_TIMEZONE_OPTIONS = "-c timezone=UTC";

/**
 * Returns `databaseUrl` with the `options=-c timezone=UTC` startup parameter
 * added. Any `-c timezone=...` pair the URL already carried is dropped — the
 * application contract wins. Everything else (credentials, sslmode,
 * connection_limit, unrelated -c pairs) is preserved unchanged.
 */
export function withUtcTimeZone(databaseUrl: string): string {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    // Not a URL at all: loadEnv() (S8) rejects it before this can matter;
    // hand it through so the failure stays where it belongs.
    return databaseUrl;
  }

  const tokens = (url.searchParams.get("options") ?? "").split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "-c" && tokens[i + 1]?.toLowerCase().startsWith("timezone=")) {
      i++; // skip the "-c timezone=..." pair
      continue;
    }
    kept.push(tokens[i]);
  }
  kept.push("-c", "timezone=UTC");

  const parts: string[] = [];
  for (const [key, value] of url.searchParams.entries()) {
    if (key === "options") continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }
  parts.push(`options=${encodeURIComponent(kept.join(" "))}`);

  // Rebuilt by hand: URL.toString() would serialize the space in `options`
  // as `+`, which connection-string parsers do NOT decode back to a space.
  const auth = url.username
    ? `${url.username}${url.password ? `:${url.password}` : ""}@`
    : "";
  return `${url.protocol}//${auth}${url.host}${url.pathname}${parts.length > 0 ? `?${parts.join("&")}` : ""}${url.hash}`;
}
