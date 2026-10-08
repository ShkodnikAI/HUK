-- H-211 (finding G1): atomic per-track moderation claim.
-- NULL = unclaimed. A claim older than 10 minutes is stale (the claiming
-- worker crashed) and may be re-taken; the claim is released when the
-- moderation pass finishes with the track.
ALTER TABLE "Track" ADD COLUMN "moderationClaimedAt" TIMESTAMP(3);
