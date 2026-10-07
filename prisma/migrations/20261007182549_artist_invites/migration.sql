-- CreateTable
CREATE TABLE "ArtistInvite" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedById" TEXT,
    "usedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArtistInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ArtistInvite_codeHash_key" ON "ArtistInvite"("codeHash");

-- CreateIndex
CREATE UNIQUE INDEX "ArtistInvite_usedById_key" ON "ArtistInvite"("usedById");

-- CreateIndex
CREATE INDEX "ArtistInvite_createdById_idx" ON "ArtistInvite"("createdById");

-- AddForeignKey
ALTER TABLE "ArtistInvite" ADD CONSTRAINT "ArtistInvite_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtistInvite" ADD CONSTRAINT "ArtistInvite_usedById_fkey" FOREIGN KEY ("usedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
