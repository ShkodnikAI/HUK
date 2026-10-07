// Audius source provider (H-202). Ships DISABLED: owner decision D3
// (Audius terms for AI music and radio-style use) is unverified, so no
// default configuration may flip `AUDIUS_ENABLED` on, and every code path
// refuses loudly while it is off (S9).

import { HttpError } from "@/server/http/errors";
import { trustedFetch, type TrustedFetchOptions } from "@/server/net/trusted-fetch";
import { safeFetchJson, type SafeLoader } from "@/server/net/safe-fetch";
import { loadEnv } from "@/server/env";
import { z } from "zod";

const AUDIUS_APP_NAME = "huk";

/** Audius track ids are alphanumeric slugs (e.g. "abc123"). */
const AUDIUS_ID_PATTERN = /^[a-zA-Z0-9]{1,64}$/;

const audiusTrackSchema = z.object({
  data: z
    .object({
      id: z.string(),
      title: z.string().max(500).optional(),
      duration: z.number().int().nonnegative().optional(),
      is_delete: z.boolean().optional(),
      is_available: z.boolean().optional(),
    })
    .passthrough(),
});

export function assertAudiusEnabled(enabled: boolean): void {
  if (!enabled) {
    throw new HttpError(
      403,
      "PROVIDER_DISABLED",
      "Audius is disabled (AUDIUS_ENABLED=false; owner decision D3 pending)",
    );
  }
}

export type AudiusResolution = {
  externalId: string;
  streamUrl: string; // served by the trusted api host
  title: string | null;
  durationSec: number | null;
};

/**
 * Resolves an Audius track id through the trusted api host. The stream URL
 * stays on the api host (HUK fetches through `trustedFetch` only).
 * `loader` is the H-201 test seam (recorded fixtures).
 */
export async function resolveAudiusTrack(
  externalId: string,
  opts?: { enabled?: boolean; loader?: SafeLoader; totalTimeoutMs?: number },
): Promise<AudiusResolution> {
  assertAudiusEnabled(opts?.enabled ?? loadAudiusEnabled());
  if (!AUDIUS_ID_PATTERN.test(externalId)) {
    throw new HttpError(422, "VALIDATION_FAILED", "Invalid fields: audius track id");
  }
  const fetchOpts: TrustedFetchOptions & { loader?: SafeLoader } = {
    method: "GET",
    totalTimeoutMs: opts?.totalTimeoutMs,
    loader: opts?.loader,
  };
  const res = await trustedFetch(
    `https://api.audius.co/v1/tracks/${encodeURIComponent(externalId)}?app_name=${AUDIUS_APP_NAME}`,
    fetchOpts,
  );
  const meta = safeFetchJson(res, audiusTrackSchema);
  if (meta.data.is_delete || meta.data.is_available === false) {
    throw new HttpError(404, "SOURCE_NOT_FOUND", "Audius track is not available");
  }
  return {
    externalId: meta.data.id,
    streamUrl: `https://api.audius.co/v1/tracks/${encodeURIComponent(externalId)}/stream?app_name=${AUDIUS_APP_NAME}`,
    title: meta.data.title ?? null,
    durationSec: meta.data.duration ?? null,
  };
}

function loadAudiusEnabled(): boolean {
  return loadEnv().AUDIUS_ENABLED;
}
