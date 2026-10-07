-- CreateTable
CREATE TABLE "ListenAggregate" (
    "trackId" TEXT NOT NULL,
    "day" TIMESTAMP(3) NOT NULL,
    "plays" INTEGER NOT NULL DEFAULT 0,
    "msListened" BIGINT NOT NULL DEFAULT 0,
    "completions" INTEGER NOT NULL DEFAULT 0,
    "skips" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ListenAggregate_pkey" PRIMARY KEY ("trackId","day")
);

-- AddForeignKey
ALTER TABLE "ListenAggregate" ADD CONSTRAINT "ListenAggregate_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE CASCADE ON UPDATE CASCADE;
