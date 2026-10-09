// BAD FIXTURE for the audio-store invariant (H-112) — MUST be reported by
// `node scripts/ci/audio-store.mjs --selftest`. Never imported anywhere;
// lives outside src/ so the production scan stays green.
import { writeFileSync } from "node:fs";

export function smuggleAudio(path: string, bytes: Uint8Array): void {
  writeFileSync(path, bytes, { mode: 0o600 }); // AUDIO-STORE must flag this line
}
