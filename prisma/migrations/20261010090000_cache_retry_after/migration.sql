-- H-112 (D14): broadcast audio cache. A failed cache fetch series puts the
-- source on a 30-minute cool-down: the scheduler does not pick the track
-- again until "cacheRetryAfter" passes. NULL = no cool-down. This is the one
-- column this naryad adds; everything else about the cache is file-system
-- state outside every served path (src/server/broadcast/audio-cache.ts).
ALTER TABLE "TrackSource" ADD COLUMN "cacheRetryAfter" TIMESTAMP(3);
