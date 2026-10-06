import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

// Очередь модерации: спорные + свежие решения
export async function GET() {
  const pending = await db.track.findMany({
    where: { status: 'PENDING', source: 'USER' },
    orderBy: { createdAt: 'asc' },
    include: { modLogs: { orderBy: { createdAt: 'asc' } } },
    take: 50,
  })
  const recentDecided = await db.track.findMany({
    where: { status: { in: ['APPROVED', 'REJECTED'] }, source: 'USER' },
    orderBy: { moderatedAt: 'desc' },
    take: 15,
    select: {
      id: true, title: true, artist: true, status: true, aiVerdict: true,
      aiConfidence: true, aiSummary: true, moderatedBy: true, moderatedAt: true,
    },
  })
  return NextResponse.json({
    ok: true,
    pending: pending.map((t) => ({
      id: t.id,
      title: t.title,
      artist: t.artist,
      uploaderName: t.uploaderName,
      genre: t.genre,
      mood: t.mood,
      durationSec: t.durationSec,
      aiVerdict: t.aiVerdict,
      aiConfidence: t.aiConfidence,
      aiSummary: t.aiSummary,
      aiDetails: t.aiDetails,
      transcript: t.transcript,
      createdAt: t.createdAt,
      logs: t.modLogs.map((l) => ({ stage: l.stage, verdict: l.verdict, payload: l.payload, createdAt: l.createdAt })),
    })),
    recent: recentDecided,
  })
}
