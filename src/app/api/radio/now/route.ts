import { NextResponse } from 'next/server'
import { getRadioNow } from '@/lib/radio'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const payload = await getRadioNow()
    return NextResponse.json(payload)
  } catch (e) {
    console.error('[radio/now]', e)
    return NextResponse.json({ error: 'Эфир недоступен' }, { status: 500 })
  }
}
