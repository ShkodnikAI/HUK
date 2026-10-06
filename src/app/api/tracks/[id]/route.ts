import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

// Статус трека (поллинг после загрузки)
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const track = await db.track.findUnique({
    where: { id },
    select: {
      id: true, title: true, artist: true, status: true, aiVerdict: true,
      aiConfidence: true, aiSummary: true, aiDetails: true, genre: true, mood: true,
      createdAt: true,
    },
  })
  if (!track) return NextResponse.json({ error: 'Не найден' }, { status: 404 })
  return NextResponse.json({ ok: true, track })
}
