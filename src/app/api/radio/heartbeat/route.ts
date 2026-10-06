import { NextRequest, NextResponse } from 'next/server'
import { touchListener } from '@/lib/listeners'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const clientId = String(body.clientId ?? '').slice(0, 64) || 'anon'
    const listeners = touchListener(clientId)
    return NextResponse.json({ ok: true, listeners })
  } catch {
    return NextResponse.json({ ok: false }, { status: 500 })
  }
}
