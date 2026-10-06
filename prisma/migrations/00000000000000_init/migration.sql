-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('LISTENER', 'ARTIST', 'MODERATOR', 'ADMIN');

-- CreateEnum
CREATE TYPE "TrackStatus" AS ENUM ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'TAKEN_DOWN', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "SourceProvider" AS ENUM ('AUDIUS', 'DIRECT_URL', 'SEED');

-- CreateEnum
CREATE TYPE "LicenseScope" AS ENUM ('RADIO_ONLY', 'RADIO_AND_PLAYLISTS');

-- CreateEnum
CREATE TYPE "TermKind" AS ENUM ('LANGUAGE', 'STYLE', 'DIRECTION');

-- CreateEnum
CREATE TYPE "ModStage" AS ENUM ('DECLARATION', 'TECHNICAL', 'FINGERPRINT', 'ASR', 'POLICY', 'HUMAN', 'TEXT_CHECK');

-- CreateEnum
CREATE TYPE "ModVerdict" AS ENUM ('PASS', 'APPROVE', 'REJECT', 'REVIEW', 'SKIPPED', 'ERROR');

-- CreateEnum
CREATE TYPE "ReactionType" AS ENUM ('LIKE', 'DISLIKE');

-- CreateEnum
CREATE TYPE "ListenMode" AS ENUM ('RADIO', 'PLAYLIST');

-- CreateEnum
CREATE TYPE "PlaylistVisibility" AS ENUM ('PRIVATE', 'UNLISTED', 'PUBLIC');

-- CreateEnum
CREATE TYPE "CommentStatus" AS ENUM ('HELD', 'VISIBLE', 'HIDDEN', 'REMOVED');

-- CreateEnum
CREATE TYPE "ReportTarget" AS ENUM ('TRACK', 'COMMENT', 'PLAYLIST', 'USER');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('OPEN', 'TRIAGED', 'ACTIONED', 'DISMISSED', 'APPEALED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" TIMESTAMP(3),
    "name" TEXT,
    "image" TEXT,
    "role" "Role" NOT NULL DEFAULT 'LISTENER',
    "locale" TEXT NOT NULL DEFAULT 'en',
    "reputation" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "bannedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "ArtistProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "bio" TEXT NOT NULL DEFAULT '',
    "links" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArtistProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Consent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "document" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "ipHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Consent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Track" (
    "id" TEXT NOT NULL,
    "artistId" TEXT,
    "title" TEXT NOT NULL,
    "status" "TrackStatus" NOT NULL DEFAULT 'DRAFT',
    "durationSec" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "language" TEXT,
    "instrumental" BOOLEAN NOT NULL DEFAULT false,
    "aiGenerated" BOOLEAN NOT NULL DEFAULT false,
    "aiTool" TEXT,
    "aiPlanAtCreation" TEXT,
    "humanContribution" TEXT,
    "licenseScope" "LicenseScope" NOT NULL DEFAULT 'RADIO_ONLY',
    "rightsDeclaredAt" TIMESTAMP(3),
    "aiConfidence" DOUBLE PRECISION,
    "aiSummary" TEXT,
    "moderatedBy" TEXT,
    "moderatedAt" TIMESTAMP(3),
    "available" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Track_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackSource" (
    "id" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "provider" "SourceProvider" NOT NULL,
    "externalId" TEXT,
    "url" TEXT NOT NULL,
    "contentHash" TEXT,
    "etag" TEXT,
    "byteLength" BIGINT,
    "verifiedAt" TIMESTAMP(3),
    "failCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,

    CONSTRAINT "TrackSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxonomyTerm" (
    "id" TEXT NOT NULL,
    "kind" "TermKind" NOT NULL,
    "slug" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "parentId" TEXT,

    CONSTRAINT "TaxonomyTerm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackTerm" (
    "trackId" TEXT NOT NULL,
    "termId" TEXT NOT NULL,
    "confirmed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "TrackTerm_pkey" PRIMARY KEY ("trackId","termId")
);

-- CreateTable
CREATE TABLE "ModerationRun" (
    "id" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "stage" "ModStage" NOT NULL,
    "verdict" "ModVerdict" NOT NULL,
    "confidence" DOUBLE PRECISION,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "costMicroUsd" INTEGER NOT NULL DEFAULT 0,
    "policyVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModerationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegionRestriction" (
    "trackId" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegionRestriction_pkey" PRIMARY KEY ("trackId","countryCode")
);

-- CreateTable
CREATE TABLE "BroadcastSlot" (
    "id" TEXT NOT NULL,
    "seq" BIGINT NOT NULL,
    "trackId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "pool" TEXT NOT NULL DEFAULT 'rest',

    CONSTRAINT "BroadcastSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StationState" (
    "id" TEXT NOT NULL DEFAULT 'main',
    "lastSeq" BIGINT NOT NULL DEFAULT 0,
    "workerBeat" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StationState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reaction" (
    "userId" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "type" "ReactionType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Reaction_pkey" PRIMARY KEY ("userId","trackId")
);

-- CreateTable
CREATE TABLE "ListenEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "anonHash" TEXT,
    "trackId" TEXT NOT NULL,
    "mode" "ListenMode" NOT NULL,
    "msListened" INTEGER NOT NULL,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "skippedEarly" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ListenEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackScore" (
    "trackId" TEXT NOT NULL,
    "categoryKey" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "nEff" DOUBLE PRECISION NOT NULL,
    "voters" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrackScore_pkey" PRIMARY KEY ("trackId","categoryKey")
);

-- CreateTable
CREATE TABLE "ChartSnapshot" (
    "id" TEXT NOT NULL,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "categoryKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChartSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChartEntry" (
    "snapshotId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "trackId" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "ChartEntry_pkey" PRIMARY KEY ("snapshotId","rank")
);

-- CreateTable
CREATE TABLE "Playlist" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "visibility" "PlaylistVisibility" NOT NULL DEFAULT 'PRIVATE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Playlist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlaylistItem" (
    "playlistId" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlaylistItem_pkey" PRIMARY KEY ("playlistId","trackId")
);

-- CreateTable
CREATE TABLE "Comment" (
    "id" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "authorId" TEXT,
    "parentId" TEXT,
    "body" TEXT NOT NULL,
    "status" "CommentStatus" NOT NULL DEFAULT 'HELD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "targetType" "ReportTarget" NOT NULL,
    "targetId" TEXT NOT NULL,
    "reporterId" TEXT,
    "reporterContact" TEXT,
    "reason" TEXT NOT NULL,
    "category" TEXT,
    "urgency" INTEGER NOT NULL DEFAULT 0,
    "status" "ReportStatus" NOT NULL DEFAULT 'OPEN',
    "resolution" TEXT,
    "resolvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "actorKind" TEXT NOT NULL DEFAULT 'user',
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BudgetLedger" (
    "day" TIMESTAMP(3) NOT NULL,
    "provider" TEXT NOT NULL,
    "costMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "calls" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "BudgetLedger_pkey" PRIMARY KEY ("day","provider")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_sessionToken_key" ON "Session"("sessionToken");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_token_key" ON "VerificationToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_identifier_token_key" ON "VerificationToken"("identifier", "token");

-- CreateIndex
CREATE UNIQUE INDEX "ArtistProfile_userId_key" ON "ArtistProfile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ArtistProfile_handle_key" ON "ArtistProfile"("handle");

-- CreateIndex
CREATE INDEX "Consent_userId_document_idx" ON "Consent"("userId", "document");

-- CreateIndex
CREATE INDEX "Track_status_available_idx" ON "Track"("status", "available");

-- CreateIndex
CREATE INDEX "Track_artistId_idx" ON "Track"("artistId");

-- CreateIndex
CREATE UNIQUE INDEX "TrackSource_trackId_key" ON "TrackSource"("trackId");

-- CreateIndex
CREATE UNIQUE INDEX "TaxonomyTerm_kind_slug_key" ON "TaxonomyTerm"("kind", "slug");

-- CreateIndex
CREATE INDEX "ModerationRun_trackId_createdAt_idx" ON "ModerationRun"("trackId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BroadcastSlot_seq_key" ON "BroadcastSlot"("seq");

-- CreateIndex
CREATE INDEX "BroadcastSlot_startsAt_idx" ON "BroadcastSlot"("startsAt");

-- CreateIndex
CREATE INDEX "Reaction_trackId_type_idx" ON "Reaction"("trackId", "type");

-- CreateIndex
CREATE INDEX "ListenEvent_trackId_createdAt_idx" ON "ListenEvent"("trackId", "createdAt");

-- CreateIndex
CREATE INDEX "ListenEvent_createdAt_idx" ON "ListenEvent"("createdAt");

-- CreateIndex
CREATE INDEX "TrackScore_categoryKey_score_idx" ON "TrackScore"("categoryKey", "score");

-- CreateIndex
CREATE UNIQUE INDEX "ChartSnapshot_weekStart_categoryKey_key" ON "ChartSnapshot"("weekStart", "categoryKey");

-- CreateIndex
CREATE INDEX "Playlist_ownerId_idx" ON "Playlist"("ownerId");

-- CreateIndex
CREATE INDEX "Comment_trackId_createdAt_idx" ON "Comment"("trackId", "createdAt");

-- CreateIndex
CREATE INDEX "Report_status_urgency_idx" ON "Report"("status", "urgency");

-- CreateIndex
CREATE INDEX "Report_targetType_targetId_idx" ON "Report"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "AuditLog_targetType_targetId_idx" ON "AuditLog"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtistProfile" ADD CONSTRAINT "ArtistProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Consent" ADD CONSTRAINT "Consent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Track" ADD CONSTRAINT "Track_artistId_fkey" FOREIGN KEY ("artistId") REFERENCES "ArtistProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackSource" ADD CONSTRAINT "TrackSource_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxonomyTerm" ADD CONSTRAINT "TaxonomyTerm_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "TaxonomyTerm"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackTerm" ADD CONSTRAINT "TrackTerm_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackTerm" ADD CONSTRAINT "TrackTerm_termId_fkey" FOREIGN KEY ("termId") REFERENCES "TaxonomyTerm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModerationRun" ADD CONSTRAINT "ModerationRun_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegionRestriction" ADD CONSTRAINT "RegionRestriction_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BroadcastSlot" ADD CONSTRAINT "BroadcastSlot_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reaction" ADD CONSTRAINT "Reaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reaction" ADD CONSTRAINT "Reaction_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListenEvent" ADD CONSTRAINT "ListenEvent_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackScore" ADD CONSTRAINT "TrackScore_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChartEntry" ADD CONSTRAINT "ChartEntry_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "ChartSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChartEntry" ADD CONSTRAINT "ChartEntry_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Playlist" ADD CONSTRAINT "Playlist_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaylistItem" ADD CONSTRAINT "PlaylistItem_playlistId_fkey" FOREIGN KEY ("playlistId") REFERENCES "Playlist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaylistItem" ADD CONSTRAINT "PlaylistItem_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Comment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

