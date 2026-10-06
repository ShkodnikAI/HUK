'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { UploadCloud, Music4, CheckCircle2, XCircle, Hourglass, Loader2, Ear } from 'lucide-react'
import { getClientUid } from '@/hooks/use-radio'
import { toast } from '@/hooks/use-toast'

const GENRES = ['поп', 'рок', 'электроника', 'хип-хоп', 'инструментал', 'эмбиент', 'фонк', 'другое']
const MOODS = ['бодро', 'спокойно', 'мечтательно', 'энергично', 'меланхолично', 'весело', 'драматично']

interface UploadResult {
  trackId: string
  status: 'PENDING' | 'APPROVED' | 'REJECTED'
  reason?: string
}

interface TrackStatus {
  id: string
  title: string
  artist: string
  status: 'PENDING' | 'APPROVED' | 'REJECTED'
  aiVerdict: string
  aiConfidence: number
  aiSummary: string
  genre: string
  mood: string
}

const STATUS_META: Record<string, { icon: typeof CheckCircle2; label: string; cls: string; hint: string }> = {
  PENDING: { icon: Ear, label: 'ИИ слушает трек', cls: 'text-amber-400 border-amber-500/40 bg-amber-500/10', hint: 'Транскрипция речи и проверка по политике станции…' },
  APPROVED: { icon: CheckCircle2, label: 'Одобрен — в ротации!', cls: 'text-teal-300 border-teal-500/40 bg-teal-500/10', hint: 'Трек зачислен в плейлист «Свежак от слушателей»' },
  REJECTED: { icon: XCircle, label: 'Отклонён', cls: 'text-red-400 border-red-500/40 bg-red-500/10', hint: 'Трек нарушает политику станции' },
}

export function UploadTab() {
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [artist, setArtist] = useState('')
  const [name, setName] = useState('')
  const [genre, setGenre] = useState<string>('')
  const [mood, setMood] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [uploadPct, setUploadPct] = useState(0)
  const [result, setResult] = useState<UploadResult | null>(null)
  const [status, setStatus] = useState<TrackStatus | null>(null)
  const [mine, setMine] = useState<TrackStatus[]>([])
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadMine = useCallback(async () => {
    const uid = getClientUid()
    if (!uid) return
    try {
      const res = await fetch(`/api/my-tracks?uid=${encodeURIComponent(uid)}`, { cache: 'no-store' })
      const data = await res.json()
      setMine(data.tracks ?? [])
    } catch { /* ignore */ }
  }, [])

  useEffect(() => { loadMine() }, [loadMine])

  // Поллинг статуса после загрузки
  const pollTrack = useCallback((trackId: string) => {
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/tracks/${trackId}`, { cache: 'no-store' })
        const data = await res.json()
        if (data.ok) {
          setStatus(data.track)
          if (data.track.status !== 'PENDING') {
            if (pollRef.current) clearInterval(pollRef.current)
            loadMine()
            if (data.track.status === 'APPROVED') {
              toast({ title: 'Трек в эфире!', description: 'ИИ-модерация одобрила вашу композицию' })
            }
          }
        }
      } catch { /* ignore */ }
    }, 3000)
  }, [loadMine])

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current) }, [])

  const doUpload = async () => {
    if (!file) { toast({ title: 'Выберите аудиофайл', variant: 'destructive' }); return }
    if (!title.trim()) { toast({ title: 'Укажите название трека', variant: 'destructive' }); return }
    setBusy(true)
    setUploadPct(0)
    setResult(null)
    setStatus(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('title', title.trim())
      fd.append('artist', artist.trim())
      fd.append('genre', genre)
      fd.append('mood', mood)
      fd.append('uploaderName', name.trim() || 'Гость')
      fd.append('uploaderId', getClientUid())

      // Загрузка с прогрессом
      const data = await new Promise<UploadResult>((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open('POST', '/api/upload')
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) setUploadPct(Math.round((e.loaded / e.total) * 100))
        }
        xhr.onload = () => {
          try {
            const j = JSON.parse(xhr.responseText)
            if (xhr.status >= 200 && xhr.status < 300 && j.ok) resolve(j)
            else reject(new Error(j.error || 'Ошибка загрузки'))
          } catch { reject(new Error('Некорректный ответ сервера')) }
        }
        xhr.onerror = () => reject(new Error('Сеть недоступна'))
        xhr.send(fd)
      })
      setResult(data)
      if (data.status === 'PENDING') {
        pollTrack(data.trackId)
      } else {
        const res = await fetch(`/api/tracks/${data.trackId}`)
        const j = await res.json()
        if (j.ok) setStatus(j.track)
        loadMine()
      }
      setFile(null); setTitle(''); setArtist('')
      const input = document.getElementById('huk-file') as HTMLInputElement | null
      if (input) input.value = ''
    } catch (e) {
      toast({ title: 'Не удалось загрузить', description: e instanceof Error ? e.message : 'Попробуйте ещё раз', variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  const shown = status ?? (result ? { id: result.trackId, title: '', artist: '', status: result.status, aiVerdict: result.status, aiConfidence: 0, aiSummary: result.reason ?? '', genre: '', mood: '' } : null)

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
      {/* Форма */}
      <Card className="border-zinc-800 bg-zinc-950/70">
        <CardContent className="space-y-5 p-6">
          <div>
            <h2 className="text-lg font-bold text-zinc-50">Загрузить композицию</h2>
            <p className="mt-1 text-sm text-zinc-500">
              mp3 / wav / ogg / m4a / flac, до 20 МБ и 12 минут. После загрузки ИИ прослушает трек:
              расшифрует речь, проверит по политике станции и решит — пропустить в эфир, отклонить или передать модератору.
            </p>
          </div>

          {/* Дропзона */}
          <label
            htmlFor="huk-file"
            onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragOver(false)
              const f = e.dataTransfer.files?.[0]
              if (f) setFile(f)
            }}
            className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-8 text-center transition-colors ${dragOver ? 'border-amber-500 bg-amber-500/10' : 'border-zinc-700 bg-zinc-900/40 hover:border-zinc-500'}`}
          >
            <UploadCloud className="h-9 w-9 text-amber-500" />
            {file ? (
              <>
                <p className="text-sm font-medium text-zinc-200">{file.name}</p>
                <p className="text-xs text-zinc-500">{(file.size / 1024 / 1024).toFixed(1)} МБ — нажмите, чтобы заменить</p>
              </>
            ) : (
              <>
                <p className="text-sm font-medium text-zinc-300">Перетащите аудиофайл или нажмите</p>
                <p className="text-xs text-zinc-500">Ваши права на композицию должны позволять публичное вещание</p>
              </>
            )}
          </label>
          <input
            id="huk-file"
            type="file"
            accept=".mp3,.wav,.ogg,.m4a,.webm,.flac,audio/*"
            className="sr-only"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="t" className="text-zinc-400">Название *</Label>
              <Input id="t" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Например: Ночной водитель" className="border-zinc-700 bg-zinc-900 text-zinc-100" maxLength={120} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="a" className="text-zinc-400">Исполнитель</Label>
              <Input id="a" value={artist} onChange={(e) => setArtist(e.target.value)} placeholder="Ваш псевдоним" className="border-zinc-700 bg-zinc-900 text-zinc-100" maxLength={120} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-zinc-400">Жанр</Label>
              <Select value={genre} onValueChange={setGenre}>
                <SelectTrigger className="border-zinc-700 bg-zinc-900 text-zinc-100"><SelectValue placeholder="Не указан" /></SelectTrigger>
                <SelectContent className="border-zinc-700 bg-zinc-900 text-zinc-100">
                  {GENRES.map((g) => <SelectItem key={g} value={g}>{g}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-zinc-400">Настроение</Label>
              <Select value={mood} onValueChange={setMood}>
                <SelectTrigger className="border-zinc-700 bg-zinc-900 text-zinc-100"><SelectValue placeholder="Не указано" /></SelectTrigger>
                <SelectContent className="border-zinc-700 bg-zinc-900 text-zinc-100">
                  {MOODS.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="n" className="text-zinc-400">Как вас представить в эфире</Label>
              <Input id="n" value={name} onChange={(e) => setName(e.target.value)} placeholder="Гость" className="border-zinc-700 bg-zinc-900 text-zinc-100" maxLength={60} />
            </div>
          </div>

          {busy && (
            <div className="space-y-1.5">
              <Progress value={uploadPct} className="h-1.5 bg-zinc-800 [&>div]:bg-amber-500" />
              <p className="text-xs text-zinc-500">Передача файла… {uploadPct}%</p>
            </div>
          )}

          <Button onClick={doUpload} disabled={busy || !file} className="h-12 w-full gap-2 bg-amber-500 font-bold text-zinc-950 hover:bg-amber-400">
            {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Music4 className="h-5 w-5" />}
            {busy ? 'Загружаем…' : 'Отправить в ИИ-модерацию'}
          </Button>

          {/* Вердикт */}
          {shown && (
            <div className={`rounded-xl border p-4 ${STATUS_META[shown.status]?.cls ?? ''}`}>
              <div className="flex items-center gap-2 font-semibold">
                {shown.status === 'PENDING'
                  ? <Ear className="h-5 w-5 animate-pulse" />
                  : shown.status === 'APPROVED'
                    ? <CheckCircle2 className="h-5 w-5" />
                    : <XCircle className="h-5 w-5" />}
                {STATUS_META[shown.status]?.label}
              </div>
              {shown.status === 'PENDING' && <p className="mt-1 text-sm opacity-80">{STATUS_META.PENDING.hint}</p>}
              {shown.aiSummary && <p className="mt-1.5 text-sm leading-snug opacity-90">{shown.aiSummary}</p>}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Мои треки */}
      <Card className="border-zinc-800 bg-zinc-950/60">
        <CardContent className="p-4">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-zinc-500">
            <Hourglass className="h-4 w-4" /> Мои загрузки
          </h3>
          {mine.length === 0 ? (
            <p className="py-6 text-center text-sm text-zinc-600">
              Здесь появится история ваших треков и вердикты ИИ
            </p>
          ) : (
            <ul className="max-h-[480px] space-y-2 overflow-y-auto pr-1">
              {mine.map((t) => (
                <li key={t.id} className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 px-3 py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-medium text-zinc-200">{t.title}</p>
                    <Badge
                      variant="outline"
                      className={`shrink-0 ${t.status === 'APPROVED' ? 'border-teal-500/40 text-teal-300' : t.status === 'REJECTED' ? 'border-red-500/40 text-red-400' : 'border-amber-500/40 text-amber-400'}`}
                    >
                      {t.status === 'APPROVED' ? 'в эфире' : t.status === 'REJECTED' ? 'отклонён' : 'проверка'}
                    </Badge>
                  </div>
                  {t.aiSummary && <p className="mt-1 line-clamp-2 text-xs leading-snug text-zinc-500">{t.aiSummary}</p>}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
