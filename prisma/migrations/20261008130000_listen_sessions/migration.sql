-- H-301: server-verified listening sessions and the reaction ip hash.
-- ListenSession rows are work-in-progress listening evidence: closed
-- sessions are purged 48 h after closing (H-210 job, listen-sessions).

CREATE TABLE "ListenSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "anonHash" TEXT,
    "trackId" TEXT NOT NULL,
    "mode" "ListenMode" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastBeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedMs" INTEGER NOT NULL DEFAULT 0,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "ListenSession_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ListenSession_trackId_startedAt_idx" ON "ListenSession"("trackId", "startedAt");
CREATE INDEX "ListenSession_closedAt_idx" ON "ListenSession"("closedAt");

ALTER TABLE "ListenSession" ADD CONSTRAINT "ListenSession_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- H-301 (S7): the reaction stores a rotating ip hash like other writes.
ALTER TABLE "Reaction" ADD COLUMN "ipHash" TEXT;
