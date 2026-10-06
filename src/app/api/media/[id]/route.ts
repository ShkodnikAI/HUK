import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { createReadStream, promises as fsp } from 'fs'
import { Readable } from 'stream'
import path from 'path'

export const dynamic = 'force-dynamic'

// Стриминг аудио с поддержкой HTTP Range (перемотка, синхронный seek)
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const track = await db.track.findUnique({ where: { id } })
  if (!track) return new Response('Трек не найден', { status: 404 })

  // PENDING/REJECTED слушаются только через панель модератора (?mod=1)
  const modPreview = new URL(req.url).searchParams.get('mod') === '1'
  if (track.status !== 'APPROVED' && !modPreview) {
    return new Response('Трек ещё не прошёл модерацию', { status: 403 })
  }

  // Защита от path traversal: файл должен лежать в upload/radio
  const baseDir = path.resolve(process.cwd(), 'upload', 'radio')
  const filePath = path.resolve(track.filePath)
  if (!filePath.startsWith(baseDir)) return new Response('Forbidden', { status: 403 })

  let fileSize: number
  try {
    const stat = await fsp.stat(filePath)
    fileSize = stat.size
  } catch {
    return new Response('Файл отсутствует на диске', { status: 404 })
  }

  const baseHeaders: Record<string, string> = {
    'Content-Type': track.mimeType || 'audio/mpeg',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  }

  const range = req.headers.get('range')
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/)
    let start = m && m[1] ? parseInt(m[1], 10) : 0
    let end = m && m[2] ? parseInt(m[2], 10) : fileSize - 1
    if (isNaN(start) || start >= fileSize) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${fileSize}` } })
    }
    if (isNaN(end) || end >= fileSize) end = fileSize - 1
    const stream = createReadStream(filePath, { start, end })
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 206,
      headers: {
        ...baseHeaders,
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Content-Length': String(end - start + 1),
      },
    })
  }

  const stream = createReadStream(filePath)
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: 200,
    headers: { ...baseHeaders, 'Content-Length': String(fileSize) },
  })
}
