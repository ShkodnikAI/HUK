import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

// Плейлисты с количеством одобренных треков
export async function GET() {
  const playlists = await db.playlist.findMany({
    orderBy: { createdAt: 'asc' },
    include: { _count: { select: { tracks: true } } },
  })
  const counts = await db.playlistTrack.groupBy({
    by: ['playlistId'],
    where: { track: { status: 'APPROVED' } },
    _count: { _all: true },
  })
  const cntMap = new Map(counts.map((c) => [c.playlistId, c._count._all]))
  return NextResponse.json({
    ok: true,
    playlists: playlists.map((p) => ({
      id: p.id,
      slug: p.slug,
      name: p.name,
      description: p.description,
      emoji: p.emoji,
      approvedTracks: cntMap.get(p.id) ?? 0,
    })),
  })
}
