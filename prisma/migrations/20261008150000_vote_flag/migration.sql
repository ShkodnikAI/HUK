-- H-304: anti-fraud v1 flags. A flagged (userId, trackId, reason) means the
-- vote carries no weight. Flags are never exposed in any response.
CREATE TABLE "VoteFlag" (
    "userId" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoteFlag_pkey" PRIMARY KEY ("userId", "trackId", "reason")
);

CREATE INDEX "VoteFlag_trackId_idx" ON "VoteFlag"("trackId");

ALTER TABLE "VoteFlag" ADD CONSTRAINT "VoteFlag_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VoteFlag" ADD CONSTRAINT "VoteFlag_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE CASCADE ON UPDATE CASCADE;
