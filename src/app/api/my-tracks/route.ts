import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

// Мои треки (по анонимному uid из localStorage)
export async function GET(req: NextRequest) {
  const uid = new URL(req.url).searchParams.get('uid')?.slice(0, 64) ?? ''
  if (!uid) return NextResponse.json({ ok: true, tracks: [] })
  const tracks = await db.track.findMany({
    where: { uploaderId: uid, source: 'USER' },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, title: true, artist: true, status: true, aiVerdict: true,
      aiSummary: true, genre: true, mood: true, playsCount: true, createdAt: true,
    },
    take: 50,
  })
  return NextResponse.json({ ok: true, tracks })
}
