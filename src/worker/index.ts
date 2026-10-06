// Worker entry (ARCHITECTURE §2): a single instance owns all scheduled work.
// H-003 scope: boot, validate env, stay alive, exit cleanly on SIGTERM.
// The broadcast scheduler arrives with H-004 behind a pg advisory lock.

import { loadEnv } from "@/server/env";

const env = loadEnv();

console.log(`[worker] booted pid=${process.pid} inviteOnly=${env.INVITE_ONLY}`);

let stopping = false;

function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  console.log(`[worker] ${signal} received — exiting cleanly`);
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

console.log("[worker] scheduler: not installed yet (H-004); idling");

// Keep the event loop alive until a termination signal arrives.
setInterval(() => {}, 1 << 30);
