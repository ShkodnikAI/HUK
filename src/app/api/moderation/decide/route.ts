import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { enrollToFresh } from '@/lib/moderation'

export const dynamic = 'force-dynamic'

// Решение модератора по спорному треку
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const trackId = String(body.trackId ?? '')
    const decision = String(body.decision ?? '') // APPROVE | REJECT
    const note = String(body.note ?? '').slice(0, 300)
    if (!trackId || !['APPROVE', 'REJECT'].includes(decision)) {
      return NextResponse.json({ ok: false, error: 'Нужны trackId и decision (APPROVE|REJECT)' }, { status: 400 })
    }
    const track = await db.track.findUnique({ where: { id: trackId } })
    if (!track) return NextResponse.json({ ok: false, error: 'Трек не найден' }, { status: 404 })
    if (track.status !== 'PENDING') {
      return NextResponse.json({ ok: false, error: 'По треку уже принято решение' }, { status: 409 })
    }

    const status = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED'
    await db.track.update({
      where: { id: trackId },
      data: { status, moderatedAt: new Date(), moderatedBy: 'human' },
    })
    await db.moderationLog.create({
      data: {
        trackId,
        stage: 'HUMAN',
        verdict: decision,
        payload: JSON.stringify({ note: note || 'Без комментария' }),
      },
    })
    if (decision === 'APPROVE') await enrollToFresh(trackId)

    return NextResponse.json({ ok: true, status })
  } catch (e) {
    console.error('[moderation/decide]', e)
    return NextResponse.json({ ok: false, error: 'Не удалось сохранить решение' }, { status: 500 })
  }
}
