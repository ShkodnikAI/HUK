-- H-123: optional artist lyrics on Track. Nullable, no default — existing
-- rows are untouched and the column simply reads NULL for them. The column
-- lives on Track, so the existing track deletion cascade removes it with
-- the row; account erasure coverage is noted on H-214 (#77).
ALTER TABLE "Track" ADD COLUMN "lyrics" TEXT;
