import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { technicalCheck, runModerationPipeline } from '@/lib/moderation'
import { promises as fsp } from 'fs'
import path from 'path'
import crypto from 'crypto'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

const MAX_SIZE = 20 * 1024 * 1024 // 20 МБ
const ALLOWED_EXT = ['.mp3', '.wav', '.ogg', '.m4a', '.webm', '.flac']
const ALLOWED_MIME = /audio\//

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData()
    const file = form.get('file') as File | null
    if (!file || !(file instanceof File)) {
      return NextResponse.json({ ok: false, error: 'Файл не передан' }, { status: 400 })
    }
    if (file.size === 0) return NextResponse.json({ ok: false, error: 'Пустой файл' }, { status: 400 })
    if (file.size > MAX_SIZE) {
      return NextResponse.json({ ok: false, error: 'Файл больше 20 МБ' }, { status: 400 })
    }
    const ext = path.extname(file.name || '').toLowerCase()
    if (!ALLOWED_EXT.includes(ext)) {
      return NextResponse.json(
        { ok: false, error: 'Формат не поддерживается: mp3, wav, ogg, m4a, webm, flac' },
        { status: 400 }
      )
    }
    // MIME не жёсткий: многие клиенты шлют octet-stream; бракуем только явный не-аудио
    if (file.type && file.type !== 'application/octet-stream' && !ALLOWED_MIME.test(file.type)) {
      return NextResponse.json(
        { ok: false, error: `Тип файла «${file.type}» не является аудио` },
        { status: 400 }
      )
    }

    const title = String(form.get('title') ?? '').trim().slice(0, 120)
    const artist = String(form.get('artist') ?? '').trim().slice(0, 120)
    const genre = String(form.get('genre') ?? '').trim().slice(0, 60)
    const mood = String(form.get('mood') ?? '').trim().slice(0, 60)
    const uploaderName = String(form.get('uploaderName') ?? 'Гость').trim().slice(0, 60) || 'Гость'
    const uploaderId = String(form.get('uploaderId') ?? '').trim().slice(0, 64)
    if (!title) return NextResponse.json({ ok: false, error: 'Укажите название трека' }, { status: 400 })
    if (!/^[a-zA-Zа-яА-ЯёЁ0-9 \-_.]+$/.test(title + artist)) {
      return NextResponse.json({ ok: false, error: 'Название и исполнитель: только буквы, цифры, дефисы' }, { status: 400 })
    }

    // Сохраняем файл
    const id = crypto.randomBytes(10).toString('hex')
    const dir = path.join(process.cwd(), 'upload', 'radio')
    await fsp.mkdir(dir, { recursive: true })
    const filePath = path.join(dir, `${id}${ext}`)
    const buf = Buffer.from(await file.arrayBuffer())
    await fsp.writeFile(filePath, buf)

    // Слой 1: техника (синхронно — мгновенный фидбек)
    const tech = await technicalCheck(filePath)
    const track = await db.track.create({
      data: {
        id,
        title,
        artist: artist || 'Неизвестен',
        uploaderName,
        uploaderId,
        source: 'USER',
        filePath,
        mimeType: file.type || 'audio/mpeg',
        durationSec: tech.durationSec,
        status: 'PENDING',
      },
    })

    if (!tech.ok) {
      await db.moderationLog.create({
        data: {
          trackId: id,
          stage: 'TECHNICAL',
          verdict: 'REJECT',
          payload: JSON.stringify({ reason: tech.reason }),
        },
      })
      await db.track.update({
        data: {
          status: 'REJECTED',
          aiVerdict: 'REJECT',
          aiConfidence: 1,
          aiSummary: tech.reason ?? 'Технические проверки не пройдены',
          moderatedAt: new Date(),
          moderatedBy: 'ai',
        },
        where: { id },
      })
      return NextResponse.json({ ok: true, trackId: id, status: 'REJECTED', reason: tech.reason })
    }

    await db.moderationLog.create({
      data: {
        trackId: id,
        stage: 'TECHNICAL',
        verdict: 'OK',
        payload: JSON.stringify({ durationSec: tech.durationSec, sizeBytes: file.size }),
      },
    })

    // Слои 2–3 (ASR + LLM) — асинхронно, статус подтянется поллингом
    runModerationPipeline(id).catch((e) => console.error('[moderation pipeline]', e))

    return NextResponse.json({ ok: true, trackId: id, status: 'PENDING' })
  } catch (e) {
    console.error('[upload]', e)
    return NextResponse.json({ ok: false, error: 'Ошибка загрузки — попробуйте ещё раз' }, { status: 500 })
  }
}
