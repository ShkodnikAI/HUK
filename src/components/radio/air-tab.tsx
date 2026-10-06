'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { Play, Pause, Users, Radio, Clock, Disc3, ListMusic, ArrowRight } from 'lucide-react'
import { Visualizer } from '@/components/radio/visualizer'
import { useRadio } from '@/hooks/use-radio'
import { toast } from '@/hooks/use-toast'

interface PlaylistInfo {
  id: string
  slug: string
  name: string
  description: string
  emoji: string
  approvedTracks: number
}

function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function AirTab({ onModerationCount }: { onModerationCount?: (n: number) => void }) {
  const { now, error, userStarted, playing, start, stop, audioRef } = useRadio()
  const [playlists, setPlaylists] = useState<PlaylistInfo[]>([])
  const [switching, setSwitching] = useState<string | null>(null)
  const [, setTick] = useState(0)
  const [mskTime, setMskTime] = useState<string | null>(null)

  // Тик прогресса и часов
  useEffect(() => {
    const iv = setInterval(() => {
      setTick((t) => t + 1)
      setMskTime(
        new Date().toLocaleTimeString('ru-RU', {
          timeZone: 'Europe/Moscow',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
      )
    }, 1000)
    return () => clearInterval(iv)
  }, [])

  const loadPlaylists = useCallback(async () => {
    try {
      const res = await fetch('/api/playlists', { cache: 'no-store' })
      const data = await res.json()
      setPlaylists(data.playlists ?? [])
    } catch { /* повтор на следующем тике */ }
  }, [])

  useEffect(() => { loadPlaylists() }, [loadPlaylists])
  useEffect(() => { onModerationCount?.(now?.stats.pendingTracks ?? 0) }, [now?.stats.pendingTracks, onModerationCount])

  const switchTo = async (pl: PlaylistInfo) => {
    if (now?.pendingPlaylist?.id === pl.id || now?.currentPlaylist?.id === pl.id) return
    setSwitching(pl.id)
    try {
      const res = await fetch('/api/radio/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playlistId: pl.id }),
      })
      const data = await res.json()
      if (data.ok) {
        toast({ title: 'Эфир переключается', description: `«${pl.name}» заиграет после текущего трека` })
        await new Promise((r) => setTimeout(r, 400))
      } else {
        toast({ title: 'Не вышло', description: data.error, variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Сеть недоступна', variant: 'destructive' })
    } finally {
      setSwitching(null)
    }
  }

  const cur = now?.current
  const skew = now ? now.serverTime - Date.now() : 0
  const elapsed = cur ? Math.max(0, (Date.now() + skew - cur.startedAt) / 1000) : 0
  const remainSec = cur ? Math.max(0, (cur.endsAt - Date.now() - skew) / 1000) : 0
  const progressPct = cur ? Math.min(100, (elapsed / cur.track.durationSec) * 100) : 0
  const isJingle = cur?.kind === 'JINGLE'

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
      {/* ── Основной блок: сейчас в эфире ── */}
      <div className="space-y-6">
        <Card className="border-zinc-800 bg-zinc-950/80 shadow-[0_0_60px_-15px_rgba(245,158,11,0.15)]">
          <CardContent className="p-6 sm:p-8">
            {/* Статус */}
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold tracking-wide ${playing ? 'border-red-500/50 bg-red-500/10 text-red-400' : 'border-zinc-700 bg-zinc-900 text-zinc-400'}`}>
                  <span className={`h-2 w-2 rounded-full ${playing ? 'animate-pulse bg-red-500' : 'bg-zinc-600'}`} />
                  {playing ? 'В ЭФИРЕ' : 'ПАУЗА'}
                </span>
                {isJingle && (
                  <Badge variant="outline" className="border-teal-500/40 bg-teal-500/10 text-teal-300">
                    ИИ-диджей ВЕКТОР
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-3 text-xs text-zinc-500">
                <span className="flex items-center gap-1 font-mono" title="Московское время">
                  <Clock className="h-3.5 w-3.5" /> {mskTime ?? '--:--:--'} МСК
                </span>
                <span className="flex items-center gap-1" title="Слушателей онлайн">
                  <Users className="h-3.5 w-3.5" /> {now?.listeners ?? 0}
                </span>
              </div>
            </div>

            {/* Трек */}
            {error ? (
              <p className="mt-8 text-center text-sm text-red-400">{error}</p>
            ) : !now || !cur ? (
              <div className="mt-8 space-y-3">
                <Skeleton className="h-8 w-2/3 bg-zinc-800" />
                <Skeleton className="h-5 w-1/3 bg-zinc-800" />
                <p className="pt-4 text-center text-sm text-zinc-500">Эфир стартует…</p>
              </div>
            ) : (
              <>
                <div className="mt-6 flex items-start gap-4">
                  <div className={`hidden sm:flex h-16 w-16 shrink-0 items-center justify-center rounded-xl border ${isJingle ? 'border-teal-500/30 bg-teal-500/10' : 'border-amber-500/30 bg-amber-500/10'}`}>
                    <Disc3 className={`h-8 w-8 animate-[spin_4s_linear_infinite] ${isJingle ? 'text-teal-400' : 'text-amber-400'}`} />
                  </div>
                  <div className="min-w-0">
                    <h2 className="truncate text-2xl font-bold tracking-tight text-zinc-50 sm:text-3xl">
                      {cur.track.title}
                    </h2>
                    <p className="mt-1 truncate text-base text-zinc-400">
                      {isJingle ? 'Станционный джингл' : cur.track.artist}
                    </p>
                    {!isJingle && (cur.track.genre || cur.track.mood) && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {cur.track.genre && <Badge variant="secondary" className="bg-zinc-800 text-zinc-300">{cur.track.genre}</Badge>}
                        {cur.track.mood && <Badge variant="secondary" className="bg-zinc-800 text-zinc-300">{cur.track.mood}</Badge>}
                        {cur.track.source === 'USER' && <Badge className="border-teal-500/40 bg-teal-500/10 text-teal-300">трек слушателя</Badge>}
                      </div>
                    )}
                  </div>
                </div>

                {/* Прогресс */}
                <div className="mt-6">
                  <Progress value={progressPct} className="h-1.5 bg-zinc-800 [&>div]:bg-amber-500" />
                  <div className="mt-1.5 flex justify-between font-mono text-xs text-zinc-500">
                    <span>{fmtTime(elapsed)}</span>
                    <span>−{fmtTime(remainSec)}</span>
                  </div>
                </div>
              </>
            )}

            {/* Визуализатор */}
            <Visualizer audioRef={audioRef} active={userStarted} className="mt-6 h-24 w-full" />

            {/* Кнопка */}
            <div className="mt-4 flex justify-center">
              {!userStarted ? (
                <Button
                  onClick={start}
                  size="lg"
                  className="h-14 w-full max-w-xs gap-2 bg-amber-500 text-base font-bold text-zinc-950 hover:bg-amber-400"
                >
                  <Play className="h-6 w-6 fill-current" /> ВКЛЮЧИТЬ ЭФИР
                </Button>
              ) : (
                <Button
                  onClick={stop}
                  size="lg"
                  variant="outline"
                  className="h-14 w-full max-w-xs gap-2 border-zinc-700 bg-zinc-900 text-base font-semibold text-zinc-200 hover:bg-zinc-800"
                >
                  {playing ? <Pause className="h-6 w-6" /> : <Play className="h-6 w-6 fill-current" />}
                  {playing ? 'Пауза' : 'Продолжить'}
                </Button>
              )}
            </div>
            {userStarted && !playing && cur && (
              <p className="mt-2 text-center text-xs text-zinc-500">Синхронизация с эфиром…</p>
            )}
          </CardContent>
        </Card>

        {/* Смена эфира */}
        <div>
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-zinc-500">
            <Radio className="h-4 w-4" /> Сменить эфир
            {now?.pendingPlaylist && (
              <Badge className="border-amber-500/40 bg-amber-500/10 text-amber-300">
                дальше: {now.pendingPlaylist.emoji} {now.pendingPlaylist.name}
              </Badge>
            )}
          </h3>
          <div className="grid gap-3 sm:grid-cols-2">
            {playlists.map((pl) => {
              const isCurrent = now?.currentPlaylist?.id === pl.id && !now?.pendingPlaylist
              const isPending = now?.pendingPlaylist?.id === pl.id
              return (
                <Card
                  key={pl.id}
                  className={`border-zinc-800 bg-zinc-950/60 transition-colors ${isPending ? 'border-amber-500/50' : isCurrent ? 'border-teal-500/40' : ''}`}
                >
                  <CardContent className="flex h-full items-center gap-3 p-4">
                    <span className="text-2xl" aria-hidden>{pl.emoji}</span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-zinc-100">{pl.name}</p>
                      <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-zinc-500">{pl.description}</p>
                      <p className="mt-1 text-[11px] text-zinc-600">{pl.approvedTracks} треков в ротации</p>
                    </div>
                    <Button
                      size="sm"
                      variant={isCurrent || isPending ? 'secondary' : 'outline'}
                      disabled={isCurrent || isPending || switching === pl.id}
                      onClick={() => switchTo(pl)}
                      className={`shrink-0 ${isCurrent ? 'bg-teal-500/15 text-teal-300' : isPending ? 'bg-amber-500/15 text-amber-300' : 'border-zinc-700 text-zinc-300 hover:bg-zinc-800'}`}
                    >
                      {isCurrent ? 'Играет' : isPending ? 'Дальше' : <><ArrowRight className="h-4 w-4" /> Включить</>}
                    </Button>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        </div>
      </div>

      {/* ── Сайдбар: далее в эфире ── */}
      <div className="space-y-4">
        <Card className="border-zinc-800 bg-zinc-950/60">
          <CardContent className="p-4">
            <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-zinc-500">
              <ListMusic className="h-4 w-4" /> Далее в эфире
            </h3>
            {now?.queue.length ? (
              <ol className="space-y-2.5">
                {now.queue.map((q, i) => (
                  <li key={q.id} className="flex items-center gap-3 rounded-lg border border-zinc-800/60 bg-zinc-900/40 px-3 py-2">
                    <span className="font-mono text-xs text-amber-500/80">{i + 1}</span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-zinc-200">{q.title}</p>
                      <p className="truncate text-xs text-zinc-500">{q.artist}</p>
                    </div>
                    <span className="font-mono text-xs text-zinc-600">{fmtTime(q.durationSec)}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="py-4 text-center text-sm text-zinc-600">Очередь формируется…</p>
            )}
          </CardContent>
        </Card>

        <Card className="border-zinc-800 bg-zinc-950/60">
          <CardContent className="p-4">
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-500">Сводка станции</h3>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-zinc-500">Треков в ротации</dt>
                <dd className="font-mono text-zinc-200">{now?.stats.approvedTracks ?? '—'}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-zinc-500">На модерации</dt>
                <dd className="font-mono text-amber-400">{now?.stats.pendingTracks ?? '—'}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-zinc-500">Плейлистов</dt>
                <dd className="font-mono text-zinc-200">{now?.stats.playlists ?? '—'}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-zinc-500">Эфиров всего</dt>
                <dd className="font-mono text-zinc-200">{now?.stats.totalPlays ?? '—'}</dd>
              </div>
            </dl>
            <p className="mt-4 border-t border-zinc-800 pt-3 text-[11px] leading-relaxed text-zinc-600">
              Все слушатели слышат один и тот же момент эфира — синхронизация по серверной шкале времени,
              как в настоящей радиостанции.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
