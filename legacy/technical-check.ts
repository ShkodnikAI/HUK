// legacy/technical-check.ts — reference copy from prototype v0.2.1 (git tag `prototype-v0.2.1`).
// Verbatim extraction of moderation layer 1 (ffprobe + ffmpeg volumedetect) from
// the prototype's src/lib/moderation.ts. This stage never used the DB or the SDK,
// so it is already self-contained: the only runtime dependencies are ffprobe/ffmpeg.
// Port target: src/server/moderation/stages/technical.ts (naryad H-204) —
//   add hard timeouts/size limits and keep the "no persistent copy of audio" rule.

import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

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
