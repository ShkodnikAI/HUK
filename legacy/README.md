# legacy/ — pieces ported from prototype v0.2.1

Source of truth for the prototype is the git tag `prototype-v0.2.1`. Files here are
reference copies to port, then delete (each naryad removes what it ports).

| File | Port to | Naryad | Notes |
|---|---|---|---|
| `use-radio.ts` | `src/lib/sync/` + player in root layout | H-105 | Keep skew/drift logic; drop polling of `/now` every 8 s in favour of cached read + resync on visibility |
| `visualizer.tsx` | `src/components/player/` | H-105 | Needs CORS from the source; degrade gracefully when absent |
| `technical-check.ts` (ffprobe/volumedetect from `moderation.ts`) | `src/server/moderation/stages/technical.ts` | H-204 | Add timeouts/size limits; no persistent copy of audio |
| `gen_music.py` | `scripts/seed-content/` | H-106 | Output to an ignored directory; no audio in git |

Not ported (by design): jingles, TTS, `z-ai-web-dev-sdk` usage, SQLite, local file uploads, `?mod=1`.
