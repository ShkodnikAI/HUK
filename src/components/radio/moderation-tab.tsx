'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { CheckCircle2, XCircle, ChevronDown, ShieldCheck, Inbox, BrainCircuit, Gavel } from 'lucide-react'
import { toast } from '@/hooks/use-toast'

interface PendingTrack {
  id: string
  title: string
  artist: string
  uploaderName: string
  genre: string
  mood: string
  durationSec: number
  aiVerdict: string
  aiConfidence: number
  aiSummary: string
  aiDetails: string
  transcript: string
  createdAt: string
}

interface RecentDecision {
  id: string
  title: string
  status: string
  aiVerdict: string
  aiConfidence: number
  aiSummary: string
  moderatedBy: string | null
}

interface Category {
  category: string
  severity: string
  evidence: string
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  } catch { return '' }
}

function parseCats(json: string): Category[] {
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? v : []
  } catch { return [] }
}

const VERDICT_BADGE: Record<string, { label: string; cls: string }> = {
  APPROVE: { label: 'ИИ: пропустить', cls: 'border-teal-500/40 bg-teal-500/10 text-teal-300' },
  REJECT: { label: 'ИИ: отклонить', cls: 'border-red-500/40 bg-red-500/10 text-red-300' },
  REVIEW: { label: 'ИИ: сомневается', cls: 'border-amber-500/40 bg-amber-500/10 text-amber-300' },
  '': { label: 'ИИ: без вердикта', cls: 'border-zinc-600 bg-zinc-800 text-zinc-400' },
}

export function ModerationTab({ refreshKey }: { refreshKey: number }) {
  const [pending, setPending] = useState<PendingTrack[]>([])
  const [recent, setRecent] = useState<RecentDecision[]>([])
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [busyId, setBusyId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/moderation/queue', { cache: 'no-store' })
      const data = await res.json()
      setPending(data.pending ?? [])
      setRecent(data.recent ?? [])
    } catch { /* ignore */ } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load, refreshKey])

  const decide = async (trackId: string, decision: 'APPROVE' | 'REJECT') => {
    setBusyId(trackId)
    try {
      const res = await fetch('/api/moderation/decide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trackId, decision, note: notes[trackId] ?? '' }),
      })
      const data = await res.json()
      if (data.ok) {
        toast({ title: decision === 'APPROVE' ? 'Трек зачислен в ротацию' : 'Трек отклонён' })
        load()
      } else {
        toast({ title: 'Ошибка', description: data.error, variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Сеть недоступна', variant: 'destructive' })
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      {/* Очередь */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-bold text-zinc-50">
            <Gavel className="h-5 w-5 text-amber-500" /> Очередь модерации
            {pending.length > 0 && (
              <Badge className="border-amber-500/40 bg-amber-500/10 text-amber-300">{pending.length}</Badge>
            )}
          </h2>
          <Button variant="outline" size="sm" onClick={load} className="border-zinc-700 text-zinc-300 hover:bg-zinc-800">
            Обновить
          </Button>
        </div>

        {loading ? (
          <p className="py-10 text-center text-sm text-zinc-500">Загрузка очереди…</p>
        ) : pending.length === 0 ? (
          <Card className="border-zinc-800 bg-zinc-950/60">
            <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
              <Inbox className="h-10 w-10 text-zinc-700" />
              <p className="text-sm font-medium text-zinc-400">Очередь пуста</p>
              <p className="max-w-sm text-xs leading-relaxed text-zinc-600">
                ИИ-конвейер справляется сам: чистые треки уходит в эфир автоматически, грубые отклоняются с доказательствами.
                Сюда попадают только спорные случаи.
              </p>
            </CardContent>
          </Card>
        ) : (
          pending.map((t) => {
            const badge = VERDICT_BADGE[t.aiVerdict] ?? VERDICT_BADGE['']
            const cats = parseCats(t.aiDetails)
            return (
              <Card key={t.id} className="border-zinc-800 bg-zinc-950/70">
                <CardContent className="space-y-3 p-4 sm:p-5">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-base font-bold text-zinc-50">{t.title}</p>
                      <p className="truncate text-sm text-zinc-400">
                        {t.artist} · загрузил {t.uploaderName} · {fmtDate(t.createdAt)}
                      </p>
                    </div>
                    <Badge variant="outline" className={badge.cls}>
                      <BrainCircuit className="mr-1 h-3.5 w-3.5" />
                      {badge.label}{t.aiConfidence ? ` · ${Math.round(t.aiConfidence * 100)}%` : ''}
                    </Badge>
                  </div>

                  {t.aiSummary && (
                    <p className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 text-sm leading-snug text-zinc-300">
                      {t.aiSummary}
                    </p>
                  )}

                  {cats.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {cats.map((c, i) => (
                        <Badge key={i} variant="secondary" className="bg-zinc-800 text-xs text-zinc-300">
                          {c.category}
                          {c.severity && c.severity !== 'low' ? ` (${c.severity})` : ''}
                        </Badge>
                      ))}
                    </div>
                  )}

                  {/* Прослушивание */}
                  <audio controls preload="none" src={`/api/media/${t.id}?mod=1`} className="h-9 w-full" />

                  {t.transcript && (
                    <Collapsible>
                      <CollapsibleTrigger className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300">
                        <ChevronDown className="h-3.5 w-3.5" /> Расшифровка речи (ASR)
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <p className="mt-2 max-h-32 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 text-xs leading-relaxed text-zinc-400">
                          {t.transcript.slice(0, 2000)}
                        </p>
                      </CollapsibleContent>
                    </Collapsible>
                  )}

                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      value={notes[t.id] ?? ''}
                      onChange={(e) => setNotes((m) => ({ ...m, [t.id]: e.target.value }))}
                      placeholder="Комментарий модератора (необязательно)"
                      className="h-10 flex-1 border-zinc-700 bg-zinc-900 text-zinc-100"
                      maxLength={300}
                    />
                    <div className="flex gap-2">
                      <Button
                        onClick={() => decide(t.id, 'APPROVE')}
                        disabled={busyId === t.id}
                        className="h-10 flex-1 gap-1.5 bg-teal-600 font-semibold text-white hover:bg-teal-500 sm:flex-none"
                      >
                        <CheckCircle2 className="h-4 w-4" /> В эфир
                      </Button>
                      <Button
                        onClick={() => decide(t.id, 'REJECT')}
                        disabled={busyId === t.id}
                        variant="outline"
                        className="h-10 flex-1 gap-1.5 border-red-500/40 text-red-400 hover:bg-red-500/10 sm:flex-none"
                      >
                        <XCircle className="h-4 w-4" /> Отклонить
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )
          })
        )}
      </div>

      {/* Последние решения */}
      <div>
        <Card className="border-zinc-800 bg-zinc-950/60">
          <CardContent className="p-4">
            <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-zinc-500">
              <ShieldCheck className="h-4 w-4" /> Последние решения
            </h3>
            {recent.length === 0 ? (
              <p className="py-4 text-center text-xs text-zinc-600">Пока нет модерированных треков</p>
            ) : (
              <ul className="max-h-[520px] space-y-2 overflow-y-auto pr-1">
                {recent.map((r) => (
                  <li key={r.id} className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 px-3 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-medium text-zinc-200">{r.title}</p>
                      <Badge
                        variant="outline"
                        className={`shrink-0 ${r.status === 'APPROVED' ? 'border-teal-500/40 text-teal-300' : 'border-red-500/40 text-red-400'}`}
                      >
                        {r.status === 'APPROVED' ? 'в эфире' : 'отклонён'}
                      </Badge>
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs leading-snug text-zinc-500">{r.aiSummary}</p>
                    <p className="mt-1 text-[11px] text-zinc-600">
                      решение: {r.moderatedBy === 'human' ? 'модератор' : 'ИИ-конвейер'}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
