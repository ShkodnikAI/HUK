-- H-101 (constraints): DB-level guarantees that prisma/schema.prisma cannot
-- express. Hand-written on top of the generated skeleton — future migrations
-- must be created with `--create-only` and this section preserved, otherwise
-- `prisma migrate dev` will generate a migration that DROPS these constraints
-- (schema.prisma does not know them). `prisma migrate deploy` (CI, production)
-- is not affected: it applies migrations in order without diffing.
--
-- Case-insensitive uniqueness: identity fields must match regardless of case.
CREATE UNIQUE INDEX "User_email_lower_key" ON "User"(lower("email"));
CREATE UNIQUE INDEX "ArtistProfile_handle_lower_key" ON "ArtistProfile"(lower("handle"));

-- Numeric domain checks.
ALTER TABLE "Track" ADD CONSTRAINT "Track_durationSec_nonnegative" CHECK ("durationSec" >= 0);
ALTER TABLE "Track" ADD CONSTRAINT "Track_aiConfidence_unit_interval" CHECK ("aiConfidence" IS NULL OR ("aiConfidence" >= 0 AND "aiConfidence" <= 1));
ALTER TABLE "ModerationRun" ADD CONSTRAINT "ModerationRun_confidence_unit_interval" CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1));
ALTER TABLE "ListenEvent" ADD CONSTRAINT "ListenEvent_msListened_nonnegative" CHECK ("msListened" >= 0);
ALTER TABLE "PlaylistItem" ADD CONSTRAINT "PlaylistItem_position_nonnegative" CHECK ("position" >= 0);
ALTER TABLE "ChartEntry" ADD CONSTRAINT "ChartEntry_rank_positive" CHECK ("rank" >= 1);
ALTER TABLE "User" ADD CONSTRAINT "User_reputation_nonnegative" CHECK ("reputation" >= 0);
ALTER TABLE "TrackSource" ADD CONSTRAINT "TrackSource_failCount_nonnegative" CHECK ("failCount" >= 0);
ALTER TABLE "Report" ADD CONSTRAINT "Report_urgency_nonnegative" CHECK ("urgency" >= 0);
ALTER TABLE "BroadcastSlot" ADD CONSTRAINT "BroadcastSlot_endsAt_after_startsAt" CHECK ("endsAt" > "startsAt");

-- Text length bounds.
ALTER TABLE "Track" ADD CONSTRAINT "Track_title_length" CHECK (char_length("title") BETWEEN 1 AND 200);
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_body_length" CHECK (char_length("body") BETWEEN 1 AND 2000);
ALTER TABLE "Playlist" ADD CONSTRAINT "Playlist_name_length" CHECK (char_length("name") BETWEEN 1 AND 100);
