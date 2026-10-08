// Transcript excerpt (H-207): rendered as TEXT, never as HTML. React
// escapes interpolated strings by default; the component exists so the
// guarantee has a single, testable home (S5: untrusted text is data).

export function TranscriptExcerpt({ text, maxLength = 400 }: { text: string; maxLength?: number }) {
  const excerpt = text.length > maxLength ? `${text.slice(0, maxLength)}…[truncated]` : text;
  return (
    <p className="whitespace-pre-wrap break-words text-sm text-neutral-300">
      {excerpt}
    </p>
  );
}
