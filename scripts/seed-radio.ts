// HUK — сид станции: плейлисты, треки, джинглы, состояние эфира
import { PrismaClient } from '@prisma/client'
import { execFile } from 'child_process'
import { promisify } from 'util'
import path from 'path'

const prisma = new PrismaClient()
const execFileAsync = promisify(execFile)

const SEED_DIR = '/home/z/my-project/upload/radio/seed'
const RADIO_DIR = '/home/z/my-project/upload/radio'

async function probeDuration(p: string): Promise<number> {
  const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', p])
  return Math.round(parseFloat(JSON.parse(stdout).format.duration) * 100) / 100
}

const PLAYLISTS = [
  { slug: 'synthwave-night', name: 'Синтвейв-полуночник', emoji: '🌃', description: 'Неоновые арпеджио и тёплые пилы. Для ночных поездок по городу-огням.' },
  { slug: 'lofi-reading', name: 'Лофай-читальня', emoji: '📚', description: 'Тихие седьмые аккорды и шум винила. Для работы, книг и дождя за окном.' },
  { slug: 'dance-floor', name: 'Танцпол Хука', emoji: '🕺', description: '124 BPM, бочка в пол и бас октавами. Когда нужно раскачать танцпол.' },
  { slug: 'fresh', name: 'Свежак от слушателей', emoji: '🔥', description: 'Одобренные ИИ-модерацией треки наших слушателей. Сюда попадает всё чистое и яркое.' },
]

const SEED_TRACKS: { file: string; title: string; artist: string; genre: string; mood: string; playlist: string }[] = [
  { file: 'synthwave_neon_rain.mp3', title: 'Неоновый дождь', artist: 'Хук-Синтез', genre: 'synthwave', mood: 'мечтательно', playlist: 'synthwave-night' },
  { file: 'synthwave_midnight.mp3', title: 'Полуночный движ', artist: 'Хук-Синтез', genre: 'synthwave', mood: 'решительно', playlist: 'synthwave-night' },
  { file: 'synthwave_outrun.mp3', title: 'Аутран в аэропорт', artist: 'Хук-Синтез', genre: 'synthwave', mood: 'лихо', playlist: 'synthwave-night' },
  { file: 'lofi_study_room.mp3', title: 'Читальня на Лунной', artist: 'Хук-Синтез', genre: 'lofi', mood: 'спокойно', playlist: 'lofi-reading' },
  { file: 'lofi_rainy_window.mp3', title: 'Дождь за окном', artist: 'Хук-Синтез', genre: 'lofi', mood: 'меланхолично', playlist: 'lofi-reading' },
  { file: 'lofi_slow_morning.mp3', title: 'Медленное утро', artist: 'Хук-Синтез', genre: 'lofi', mood: 'нежно', playlist: 'lofi-reading' },
  { file: 'dance_pulse_floor.mp3', title: 'Танцпол Хука', artist: 'Хук-Синтез', genre: 'dance', mood: 'энергично', playlist: 'dance-floor' },
  { file: 'dance_neon_bass.mp3', title: 'Неоновый бас', artist: 'Хук-Синтез', genre: 'dance', mood: 'жёстко', playlist: 'dance-floor' },
  { file: 'dance_afterglow.mp3', title: 'После ощущений', artist: 'Хук-Синтез', genre: 'dance', mood: 'на подъёме', playlist: 'dance-floor' },
]

const JINGLES = [
  { file: 'jingle_1.mp3', title: 'ИД: Вы слушаете HUK' },
  { file: 'jingle_2.mp3', title: 'ИД: Ваши треки — наша волна' },
  { file: 'jingle_3.mp3', title: 'ИД: Диджей Вектор на связи' },
  { file: 'jingle_4.mp3', title: 'ИД: Музыка не останавливается' },
]

async function main() {
  const existing = await prisma.playlist.count()
  if (existing > 0) {
    console.log('Сид уже применён — пропускаю')
    return
  }

  const plMap = new Map<string, string>()
  for (const pl of PLAYLISTS) {
    const created = await prisma.playlist.create({
      data: { slug: pl.slug, name: pl.name, emoji: pl.emoji, description: pl.description },
    })
    plMap.set(pl.slug, created.id)
  }
  console.log(`Плейлистов создано: ${plMap.size}`)

  let order = new Map<string, number>()
  for (const t of SEED_TRACKS) {
    const filePath = path.join(SEED_DIR, t.file)
    const durationSec = await probeDuration(filePath)
    const track = await prisma.track.create({
      data: {
        title: t.title, artist: t.artist, uploaderName: 'HUK Studio',
        source: 'SEED', filePath, mimeType: 'audio/mpeg', durationSec,
        status: 'APPROVED', genre: t.genre, mood: t.mood,
        aiVerdict: 'APPROVE', aiConfidence: 1,
        aiSummary: 'Сид-контент станции (процедурная генерация, без копирайта)',
        moderatedAt: new Date(), moderatedBy: 'ai',
      },
    })
    await prisma.playlistTrack.create({
      data: { playlistId: plMap.get(t.playlist)!, trackId: track.id, order: order.get(t.playlist) ?? 0 },
    })
    order.set(t.playlist, (order.get(t.playlist) ?? 0) + 1)
    console.log(`  трек: «${t.title}» ${durationSec}s → ${t.playlist}`)
  }

  for (const j of JINGLES) {
    const filePath = path.join(RADIO_DIR, j.file)
    const durationSec = await probeDuration(filePath)
    await prisma.track.create({
      data: {
        title: j.title, artist: 'ИИ-диджей ВЕКТОР', uploaderName: 'HUK Studio',
        source: 'JINGLE', filePath, mimeType: 'audio/mpeg', durationSec,
        status: 'APPROVED', genre: 'jingle', mood: 'бодро',
        aiVerdict: 'APPROVE', aiConfidence: 1,
        aiSummary: 'Станционный джингл ИИ-диджея (синтезированный голос)',
        moderatedAt: new Date(), moderatedBy: 'ai',
      },
    })
    console.log(`  джингл: «${j.title}» ${durationSec}s`)
  }

  await prisma.stationState.create({
    data: { id: 'main', currentPlaylistId: plMap.get('synthwave-night')! },
  })
  console.log('StationState создан. СИД ГОТОВ.')
}

main().catch(console.error).finally(() => prisma.$disconnect())
