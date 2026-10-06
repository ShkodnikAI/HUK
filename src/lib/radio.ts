import { db } from '@/lib/db'
import { countListeners } from '@/lib/listeners'

// ─────────────────────────────────────────────────────────────
// ЭФИРНЫЙ ДВИЖОК «HUK»
// Виртуальная шкала времени: станция ведёт бесконечную программу
// передач. Все слушатели слышат один и тот же момент эфира,
// синхронизация — по серверным меткам startedAt/endedAt.
// ─────────────────────────────────────────────────────────────

const TRACK_GAP_MS = 1600 // тишина между треками (входит в endedAt)
const JINGLE_EVERY = 4 // джингл ИИ-диджея каждые N песен
const QUEUE_SIZE = 3 // сколько песен держать в очереди «Далее»
const IDLE_REANCHOR_MS = 5 * 60_000 // если эфир молчал дольше — якоримся на «сейчас»

export interface QueueItem {
  trackId: string
  kind: 'SONG' | 'JINGLE'
}

let mutex: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = mutex.then(fn as () => Promise<unknown>, fn as () => Promise<unknown>)
  mutex = run.catch(() => undefined)
  return run
}

async function getOrCreateState() {
  const existing = await db.stationState.findUnique({ where: { id: 'main' } })
  if (existing) return existing
  return db.stationState.create({ data: { id: 'main' } })
}

// Случайный Approved-трек по критерию
async function randomTrackBy(opts: { source?: string; excludeIds?: string[] }) {
  const tracks = await db.track.findMany({
    where: {
      status: 'APPROVED',
      durationSec: { gt: 0 },
      ...(opts.source ? { source: opts.source } : {}),
    },
    select: { id: true },
  })
  const pool = tracks.filter((t) => !(opts.excludeIds ?? []).includes(t.id))
  const list = pool.length ? pool : tracks
  if (!list.length) return null
  return list[Math.floor(Math.random() * list.length)]
}

async function randomSongFromPlaylist(playlistId: string | null, excludeIds: string[]) {
  if (playlistId) {
    const rows = await db.playlistTrack.findMany({
      where: { playlistId, track: { status: 'APPROVED', source: { not: 'JINGLE' } } },
      select: { trackId: true },
    })
    const ids = rows.map((r) => r.trackId).filter((id) => !excludeIds.includes(id))
    const pool = ids.length ? ids : rows.map((r) => r.trackId)
    if (pool.length) return pool[Math.floor(Math.random() * pool.length)]
  }
  // фолбэк: любая Approved-песня станции
  const t = await randomTrackBy({ excludeIds })
  return t?.id ?? null
}

async function refillQueue(playlistId: string | null) {
  const state = await getOrCreateState()
  const queue = JSON.parse(state.nextQueue || '[]') as QueueItem[]
  if (queue.length >= QUEUE_SIZE) return
  const excludeIds = queue.map((q) => q.trackId)
  const last = await db.broadcastSession.findFirst({
    orderBy: { startedAt: 'desc' },
    select: { trackId: true },
  })
  if (last) excludeIds.push(last.trackId)
  while (queue.length < QUEUE_SIZE) {
    const id = await randomSongFromPlaylist(playlistId, excludeIds)
    if (!id) break
    excludeIds.push(id)
    queue.push({ trackId: id, kind: 'SONG' })
  }
  await db.stationState.update({
    where: { id: 'main' },
    data: { nextQueue: JSON.stringify(queue) },
  })
}

// Выбор следующего элемента эфира: джингл по счётчику, иначе песня из очереди
async function pickNextItem(state: { lastJingleAt: number; nextQueue: string }): Promise<QueueItem | null> {
  if (state.lastJingleAt >= JINGLE_EVERY) {
    const jingle = await randomTrackBy({ source: 'JINGLE' })
    if (jingle) return { trackId: jingle.id, kind: 'JINGLE' }
  }
  const queue = JSON.parse(state.nextQueue || '[]') as QueueItem[]
  while (queue.length) {
    const item = queue.shift() as QueueItem
    const t = await db.track.findUnique({ where: { id: item.trackId }, select: { status: true } })
    if (t && t.status === 'APPROVED') {
      await db.stationState.update({
        where: { id: 'main' },
        data: { nextQueue: JSON.stringify(queue) },
      })
      return { trackId: item.trackId, kind: 'SONG' }
    }
  }
  return null
}

// Создать сессию эфира, стартующую в заданный момент
async function createSession(startedAtMs: number, playlistId: string | null) {
  const state = await getOrCreateState()
  const last = await db.broadcastSession.findFirst({
    orderBy: { startedAt: 'desc' },
    select: { trackId: true },
  })
  let item = await pickNextItem(state)
  // Очередь пуста — берём случайную песню напрямую
  if (!item) {
    const songId = await randomSongFromPlaylist(playlistId, last ? [last.trackId] : [])
    if (!songId) return null
    item = { trackId: songId, kind: 'SONG' }
  }
  const track = await db.track.findUnique({ where: { id: item.trackId } })
  if (!track || track.status !== 'APPROVED' || track.durationSec <= 0) return null

  const session = await db.broadcastSession.create({
    data: {
      trackId: track.id,
      playlistId: item.kind === 'SONG' ? playlistId : null,
      kind: item.kind,
      startedAt: new Date(startedAtMs),
      endedAt: new Date(startedAtMs + track.durationSec * 1000 + TRACK_GAP_MS),
    },
    include: { track: true },
  })

  if (item.kind === 'SONG') {
    await db.track.update({ where: { id: track.id }, data: { playsCount: { increment: 1 } } })
    await db.stationState.update({ where: { id: 'main' }, data: { lastJingleAt: { increment: 1 } } })
  } else {
    await db.stationState.update({ where: { id: 'main' }, data: { lastJingleAt: 0 } })
  }
  return session
}

// Применить отложенную смену плейлиста
async function applyPendingSwitch() {
  const state = await getOrCreateState()
  if (state.pendingPlaylistId && state.pendingPlaylistId !== state.currentPlaylistId) {
    const pl = await db.playlist.findUnique({ where: { id: state.pendingPlaylistId } })
    if (pl) {
      await db.stationState.update({
        where: { id: 'main' },
        data: { currentPlaylistId: pl.id, pendingPlaylistId: null },
      })
    } else {
      await db.stationState.update({ where: { id: 'main' }, data: { pendingPlaylistId: null } })
    }
  }
}

// Гарантировать активную сессию эфира (+ достроить цепочку вперёд)
async function ensureBroadcast() {
  const now = Date.now()

  let active = await db.broadcastSession.findFirst({
    where: { startedAt: { lte: new Date(now) }, endedAt: { gt: new Date(now) } },
    orderBy: { startedAt: 'desc' },
    include: { track: true },
  })
  // Битая сессия (трек отклонён модератором постфактум) — выкидываем
  if (active && active.track.status !== 'APPROVED') {
    await db.broadcastSession.delete({ where: { id: active.id } })
    active = null
  }

  if (!active) {
    await applyPendingSwitch()
    const state = await getOrCreateState()
    const playlistId = state.currentPlaylistId
    const latest = await db.broadcastSession.findFirst({
      orderBy: { startedAt: 'desc' },
    })
    // Якорь старта: сразу после предыдущего трека, либо «сейчас», если эфир молчал
    let startAt = now + 300
    if (latest) {
      const prevEnd = latest.endedAt.getTime()
      if (now - prevEnd < IDLE_REANCHOR_MS && prevEnd >= now) startAt = prevEnd
    }
    const created = await createSession(startAt, playlistId)
    if (created) active = created as typeof active
  }

  // Достроить цепочку на один трек вперёд (чтобы шкала не рвалась)
  if (active) {
    const upcoming = await db.broadcastSession.findFirst({
      where: { startedAt: { gte: active.endedAt } },
    })
    if (!upcoming) {
      const state = await getOrCreateState()
      const playlistId = state.currentPlaylistId
      await createSession(active.endedAt.getTime(), playlistId)
      await refillQueue(playlistId)
    }
  }

  return active
}

export interface RadioNowPayload {
  serverTime: number
  current: {
    sessionId: string
    kind: 'SONG' | 'JINGLE'
    startedAt: number
    endsAt: number
    track: {
      id: string
      title: string
      artist: string
      genre: string
      mood: string
      source: string
      durationSec: number
      playsCount: number
    }
  } | null
  queue: { id: string; title: string; artist: string; durationSec: number; kind: string }[]
  currentPlaylist: { id: string; name: string; emoji: string; slug: string } | null
  pendingPlaylist: { id: string; name: string; emoji: string } | null
  listeners: number
  stats: { approvedTracks: number; pendingTracks: number; playlists: number; totalPlays: number }
}

export async function getRadioNow(): Promise<RadioNowPayload> {
  return withLock(async () => {
    const active = await ensureBroadcast()
    const state = await getOrCreateState()

    const [currentPlaylist, pendingPlaylist, queueRaw] = await Promise.all([
      state.currentPlaylistId
        ? db.playlist.findUnique({ where: { id: state.currentPlaylistId } })
        : null,
      state.pendingPlaylistId
        ? db.playlist.findUnique({ where: { id: state.pendingPlaylistId } })
        : null,
      Promise.resolve(JSON.parse(state.nextQueue || '[]') as QueueItem[]),
    ])

    const queueIds = queueRaw.map((q) => q.trackId)
    const queueTracks = queueIds.length
      ? await db.track.findMany({
          where: { id: { in: queueIds }, status: 'APPROVED' },
          select: { id: true, title: true, artist: true, durationSec: true, source: true },
        })
      : []
    const byId = new Map(queueTracks.map((t) => [t.id, t]))
    const queue = queueRaw
      .map((q) => {
        const t = byId.get(q.trackId)
        return t
          ? { id: t.id, title: t.title, artist: t.artist, durationSec: t.durationSec, kind: 'SONG' }
          : null
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)

    const [approvedTracks, pendingTracks, playlists, agg] = await Promise.all([
      db.track.count({ where: { status: 'APPROVED' } }),
      db.track.count({ where: { status: 'PENDING' } }),
      db.playlist.count(),
      db.broadcastSession.aggregate({ _count: { _all: true } }),
    ])

    return {
      serverTime: Date.now(),
      current: active
        ? {
            sessionId: active.id,
            kind: active.kind as 'SONG' | 'JINGLE',
            startedAt: active.startedAt.getTime(),
            endsAt: active.endedAt.getTime(),
            track: {
              id: active.track.id,
              title: active.track.title,
              artist: active.track.artist,
              genre: active.track.genre,
              mood: active.track.mood,
              source: active.track.source,
              durationSec: active.track.durationSec,
              playsCount: active.track.playsCount,
            },
          }
        : null,
      queue,
      currentPlaylist: currentPlaylist
        ? { id: currentPlaylist.id, name: currentPlaylist.name, emoji: currentPlaylist.emoji, slug: currentPlaylist.slug }
        : null,
      pendingPlaylist: pendingPlaylist
        ? { id: pendingPlaylist.id, name: pendingPlaylist.name, emoji: pendingPlaylist.emoji }
        : null,
      listeners: countListeners(),
      stats: {
        approvedTracks,
        pendingTracks,
        playlists,
        totalPlays: agg._count._all,
      },
    }
  })
}

// Смена эфира: применяется на стыке треков
export async function switchPlaylist(playlistId: string) {
  const pl = await db.playlist.findUnique({ where: { id: playlistId } })
  if (!pl) return { ok: false, error: 'Плейлист не найден' }
  const cnt = await db.playlistTrack.count({
    where: { playlistId, track: { status: 'APPROVED' } },
  })
  if (cnt === 0) return { ok: false, error: 'В плейлисте нет одобренных треков' }
  await db.stationState.update({ where: { id: 'main' }, data: { pendingPlaylistId: playlistId } })
  return { ok: true }
}
