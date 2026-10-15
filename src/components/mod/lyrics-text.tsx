// Lyrics display (H-123 task 6): the artist's own words are untrusted
// plain text — rendered as TEXT, never as HTML (S5). The component exists
// so the guarantee has a single, testable home, mirroring
// TranscriptExcerpt; the moderator console renders full lyrics (the cap
// is LYRICS_MAX_CHARS, default 6000 — not an excerpt).

export function LyricsText({ text }: { text: string }) {
  return <p className="whitespace-pre-wrap break-words text-sm text-neutral-300">{text}</p>;
}
