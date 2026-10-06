import { NextRequest, NextResponse } from 'next/server'
import { switchPlaylist } from '@/lib/radio'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const playlistId = String(body.playlistId ?? '')
    if (!playlistId) return NextResponse.json({ ok: false, error: 'Не указан плейлист' }, { status: 400 })
    const res = await switchPlaylist(playlistId)
    return NextResponse.json(res, { status: res.ok ? 200 : 400 })
  } catch (e) {
    console.error('[radio/switch]', e)
    return NextResponse.json({ ok: false, error: 'Не удалось сменить эфир' }, { status: 500 })
  }
}
