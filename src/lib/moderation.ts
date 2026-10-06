import { db } from '@/lib/db'
import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import os from 'os'
import ZAI from 'z-ai-web-dev-sdk'

const execFileAsync = promisify(execFile)

// ─────────────────────────────────────────────────────────────
// ИИ-КОНВЕЙЕР МОДЕРАЦИИ «HUK»
// Слой 1 — техника: ffprobe (длительность/валидность), ffmpeg volumedetect (тишина)
// Слой 2 — ASR: транскрипция первых 60 секунд (z-ai-web-dev-sdk)
// Слой 3 — LLM-политика: вердикт с категориями и доказательствами
// Финал: авто-апрув / авто-отклон / на усмотрение человека (PENDING)
// Каждый шаг пишется в ModerationLog (полный аудит).
// ─────────────────────────────────────────────────────────────

export interface ModCategory {
  category: string
  severity: 'low' | 'medium' | 'high'
  evidence: string
}

export interface LlmVerdict {
  verdict: 'APPROVE' | 'REJECT' | 'REVIEW'
  confidence: number
  categories: ModCategory[]
  summary: string
  suggest_genre?: string
  suggest_mood?: string
}

const AUTO_CONFIDENCE = 0.75 // ниже — только человек решает

async function logStage(trackId: string, stage: string, verdict: string, payload: unknown) {
  await db.moderationLog.create({
    data: { trackId, stage, verdict, payload: JSON.stringify(payload) },
  })
}

// ── Слой 1: технические проверки ─────────────────────────────
export async function technicalCheck(filePath: string): Promise<{ ok: boolean; durationSec: number; reason?: string }> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'json',
      filePath,
    ])
    const duration = parseFloat(JSON.parse(stdout).format?.duration ?? '0')
    if (!isFinite(duration) || duration <= 0) {
      return { ok: false, durationSec: 0, reason: 'Не удалось определить длительность — файл повреждён или это не аудио' }
    }
    if (duration < 15) return { ok: false, durationSec: duration, reason: 'Слишком короткий трек (минимум 15 секунд)' }
    if (duration > 12 * 60) return { ok: false, durationSec: duration, reason: 'Слишком длинный трек (максимум 12 минут)' }

    // Детектор тишины: средняя громкость ниже -55 дБ → эфир не нужен
    try {
      const { stderr } = await execFileAsync('ffmpeg', ['-i', filePath, '-af', 'volumedetect', '-f', 'null', '-'], { timeout: 30_000 })
      const m = stderr.match(/mean_volume:\s*(-?[\d.]+)\s*dB/)
      if (m && parseFloat(m[1]) < -55) {
        return { ok: false, durationSec: duration, reason: 'Дорожка практически без звука (тишина)' }
      }
    } catch {
      // volumedetect необязателен — не блокируем загрузку
    }
    return { ok: true, durationSec: Math.round(duration * 100) / 100 }
  } catch {
    return { ok: false, durationSec: 0, reason: 'ffprobe не смог прочитать файл — поддерживаются mp3/wav/ogg/m4a' }
  }
}

// ── Слой 2: ASR-транскрипция первых 60 секунд ────────────────
export async function transcribeAudio(filePath: string): Promise<{ transcript: string; ok: boolean }> {
  const tmp = path.join(os.tmpdir(), `huk_${Date.now()}.wav`)
  try {
    await execFileAsync('ffmpeg', [
      '-y', '-i', filePath, '-t', '60', '-ac', '1', '-ar', '16000', '-f', 'wav', tmp,
    ], { timeout: 45_000 })
    const buf = await fsp.readFile(tmp)
    // ASR хорошо работает на файлах до ~1.5 МБ base64; крупные режем по 45 сек
    let audioBuf = buf
    if (buf.length > 1_200_000) {
      await execFileAsync('ffmpeg', ['-y', '-i', filePath, '-t', '45', '-ac', '1', '-ar', '16000', '-f', 'wav', tmp], { timeout: 45_000 })
      audioBuf = await fsp.readFile(tmp)
    }
    if (audioBuf.length === 0) return { transcript: '', ok: false }
    const zai = await ZAI.create()
    const res = await zai.audio.asr.create({ file_base64: audioBuf.toString('base64') })
    const text = (res?.text ?? '').trim()
    return { transcript: text, ok: text.length > 0 }
  } catch {
    return { transcript: '', ok: false }
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
  }
}

// ── Слой 3: LLM-политика ─────────────────────────────────────
const POLICY_PROMPT = `Ты — модератор контента круглосуточной интернет-радиостанции «HUK». Тебе переданы метаданные музыкального трека и расшифровка его звучащей речи (автораспознавание, возможны ошибки).

Проверь трек по политике станции. Запрещено:
1. Ненависть и дискриминация — расизм, ксенофобия, сексизм, разжигание вражды к группам людей.
2. Насилие и угрозы — пропаганда насилия, жестокого обращения, доведение до вреда.
3. Наркотики — пропаганда употребления, изготовления или распространения.
4. Сексуальный контент — откровенные тексты, пошлость.
5. Экстремизм и терроризм — любые призывы или оправдание.
6. Оскорбления и мат — в названии трека или имени исполнителя (в тексте песни — оцени по контексту severity).
7. Спам и реклама — реклама товаров/услуг/каналов, призывы переходить куда-либо.
8. Мошенничество — обещания лёгких денег, фишинг.

Правила оценки:
- Инструментальная музыка без распознанного текста — чистая, если метаданные чистые.
- Маскировка слов (звёздочки, замена букв, leetspeak) — трактовать как нарушение.
- ASR мог исказить слова: учитывай это при уверенности, не выдумывай нарушений.
- Если нарушений нет — верни APPROVE с высокой уверенностью.
- Если нарушение очевидно и серьёзно — REJECT.
- Если сомневаешься или данных мало — REVIEW (решит человек).

Ответь СТРОГО одним валидным JSON без markdown-разметки:
{"verdict":"APPROVE","confidence":0.95,"categories":[{"category":"название категории","severity":"low","evidence":"цитата или обоснование"}],"summary":"краткое объяснение по-русски","suggest_genre":"жанр","suggest_mood":"настроение"}`

export async function moderateWithLlm(meta: {
  title: string
  artist: string
  genre: string
  mood: string
  transcript: string
}): Promise<LlmVerdict> {
  const userMsg = `Метаданные трека:
Название: ${meta.title || '(без названия)'}
Исполнитель: ${meta.artist || '(не указан)'}
Жанр (от загрузившего): ${meta.genre || '(не указан)'}
Настроение: ${meta.mood || '(не указано)'}

Расшифровка звучащей речи (ASR, первые ~60 секунд):
${meta.transcript ? meta.transcript.slice(0, 4000) : '(речь не распознана — вероятно, инструментальная музыка)'}`

  const zai = await ZAI.create()
  const completion = await zai.chat.completions.create({
    messages: [
      { role: 'system', content: POLICY_PROMPT },
      { role: 'user', content: userMsg },
    ],
    thinking: { type: 'disabled' },
    temperature: 0.1,
  })
  const raw = completion.choices[0]?.message?.content ?? ''
  const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('LLM вернул не-JSON ответ')
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as LlmVerdict
  if (!['APPROVE', 'REJECT', 'REVIEW'].includes(parsed.verdict)) throw new Error('Неизвестный вердикт')
  return {
    verdict: parsed.verdict,
    confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0)),
    categories: Array.isArray(parsed.categories) ? parsed.categories : [],
    summary: String(parsed.summary || '').slice(0, 500),
    suggest_genre: parsed.suggest_genre,
    suggest_mood: parsed.suggest_mood,
  }
}

// ── Полный конвейер для загруженного трека ───────────────────
export async function runModerationPipeline(trackId: string): Promise<void> {
  const track = await db.track.findUnique({ where: { id: trackId } })
  if (!track) return

  try {
    // Слой 2: ASR
    const asr = await transcribeAudio(track.filePath)
    await logStage(trackId, 'ASR', asr.ok ? 'OK' : 'INFO', {
      transcriptChars: asr.transcript.length,
      note: asr.ok ? 'Речь распознана' : 'Речь не распознана (вероятно, инструментал)',
    })
    await db.track.update({ where: { id: trackId }, data: { transcript: asr.transcript } })

    // Слой 3: LLM-политика
    let verdict: LlmVerdict
    try {
      verdict = await moderateWithLlm({
        title: track.title,
        artist: track.artist,
        genre: track.genre,
        mood: track.mood,
        transcript: asr.transcript,
      })
    } catch (e) {
      await logStage(trackId, 'LLM_POLICY', 'REVIEW', {
        error: e instanceof Error ? e.message : String(e),
        note: 'ИИ-верdict не получен — передано человеку',
      })
      await db.track.update({
        where: { id: trackId },
        data: { status: 'PENDING', aiVerdict: 'REVIEW', aiSummary: 'ИИ-модерация не дала уверенного ответа — требуется решение модератора', moderatedAt: new Date(), moderatedBy: 'ai' },
      })
      return
    }

    await logStage(trackId, 'LLM_POLICY', verdict.verdict, {
      confidence: verdict.confidence,
      categories: verdict.categories,
      summary: verdict.summary,
    })

    // Финальное решение
    let finalStatus: 'APPROVED' | 'REJECTED' | 'PENDING'
    if (verdict.verdict === 'APPROVE' && verdict.confidence >= AUTO_CONFIDENCE) finalStatus = 'APPROVED'
    else if (verdict.verdict === 'REJECT' && verdict.confidence >= AUTO_CONFIDENCE) finalStatus = 'REJECTED'
    else finalStatus = 'PENDING'

    await db.track.update({
      where: { id: trackId },
      data: {
        status: finalStatus,
        aiVerdict: verdict.verdict,
        aiConfidence: verdict.confidence,
        aiSummary: verdict.summary,
        aiDetails: JSON.stringify(verdict.categories),
        genre: !track.genre && verdict.suggest_genre ? verdict.suggest_genre : track.genre,
        mood: !track.mood && verdict.suggest_mood ? verdict.suggest_mood : track.mood,
        moderatedAt: new Date(),
        moderatedBy: 'ai',
      },
    })

    // Одобренные треки слушателей попадают в плейлист «Свежак от слушателей»
    if (finalStatus === 'APPROVED' && track.source === 'USER') {
      await enrollToFresh(trackId)
    }
  } catch (e) {
    await logStage(trackId, 'LLM_POLICY', 'REVIEW', {
      error: e instanceof Error ? e.message : String(e),
      note: 'Сбой конвейера — передано человеку',
    })
    await db.track.update({
      where: { id: trackId },
      data: { status: 'PENDING', aiVerdict: 'REVIEW', aiSummary: 'Сбой ИИ-конвейера — требуется ручная проверка', moderatedAt: new Date(), moderatedBy: 'ai' },
    })
  }
}

// Зачислить одобренный трек в плейлист «Свежак от слушателей»
export async function enrollToFresh(trackId: string) {
  const fresh = await db.playlist.findUnique({ where: { slug: 'fresh' } })
  if (!fresh) return
  const exists = await db.playlistTrack.findUnique({
    where: { playlistId_trackId: { playlistId: fresh.id, trackId } },
  })
  if (exists) return
  const cnt = await db.playlistTrack.count({ where: { playlistId: fresh.id } })
  await db.playlistTrack.create({
    data: { playlistId: fresh.id, trackId, order: cnt },
  })
  await logStage(trackId, 'ENROLL', 'INFO', { playlist: 'fresh', note: 'Зачислен в ротацию «Свежак от слушателей»' })
}
