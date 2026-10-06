'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

export interface RadioTrackInfo {
  id: string
  title: string
  artist: string
  genre: string
  mood: string
  source: string
  durationSec: number
  playsCount: number
}

export interface RadioNow {
  serverTime: number
  current: {
    sessionId: string
    kind: 'SONG' | 'JINGLE'
    startedAt: number
    endsAt: number
    track: RadioTrackInfo
  } | null
  queue: { id: string; title: string; artist: string; durationSec: number; kind: string }[]
  currentPlaylist: { id: string; name: string; emoji: string; slug: string } | null
  pendingPlaylist: { id: string; name: string; emoji: string } | null
  listeners: number
  stats: { approvedTracks: number; pendingTracks: number; playlists: number; totalPlays: number }
}

// Ключ синхронного прослушивания: все клиенты выравниваются по серверной
// шкале времени (skew = серверное время − локальное), дрейф корректируется seek'ом.
export function useRadio() {
  const [now, setNow] = useState<RadioNow | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [userStarted, setUserStarted] = useState(false)
  const [playing, setPlaying] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const skewRef = useRef(0)
  const wantPlayRef = useRef(false)
  const sessionRef = useRef<string | null>(null)

  // Аудиоэлемент — синглтон
  useEffect(() => {
    const audio = new Audio()
    audio.preload = 'auto'
    audioRef.current = audio
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    return () => {
      audio.pause()
      audio.src = ''
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
    }
  }, [])

  const fetchNow = useCallback(async (): Promise<RadioNow | null> => {
    try {
      const res = await fetch('/api/radio/now', { cache: 'no-store' })
      if (!res.ok) throw new Error('bad status')
      const data: RadioNow = await res.json()
      skewRef.current = data.serverTime - Date.now()
      setNow(data)
      setError(null)
      return data
    } catch {
      setError('Нет связи со станцией')
      return null
    }
  }, [])

  // При смене сессии: новый источник + синхронный seek + продолжить играть
  const applySession = useCallback((data: RadioNow) => {
    const audio = audioRef.current
    const cur = data.current
    if (!audio || !cur) return
    if (sessionRef.current === cur.sessionId) return
    sessionRef.current = cur.sessionId
    audio.src = `/api/media/${cur.track.id}`
    audio.load()
    const onMeta = () => {
      const off = (Date.now() + skewRef.current - cur.startedAt) / 1000
      if (off > 0 && off < cur.track.durationSec - 0.4) {
        try { audio.currentTime = off } catch { /* ignore */ }
      }
      if (wantPlayRef.current) audio.play().catch(() => {})
    }
    if (audio.readyState >= 1) onMeta()
    else audio.addEventListener('loadedmetadata', onMeta, { once: true })
  }, [])

  // Поллинг эфира
  useEffect(() => {
    let alive = true
    const tick = async () => {
      const d = await fetchNow()
      if (d && alive) applySession(d)
    }
    tick()
    const iv = setInterval(tick, 8000)
    const onVis = () => { if (document.visibilityState === 'visible') tick() }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      alive = false
      clearInterval(iv)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [fetchNow, applySession])

  // Коррекция дрейфа каждые 3 секунды
  useEffect(() => {
    const iv = setInterval(() => {
      const audio = audioRef.current
      const cur = now?.current
      if (!audio || !cur || audio.paused || !wantPlayRef.current) return
      const expected = (Date.now() + skewRef.current - cur.startedAt) / 1000
      if (expected > 0 && expected < cur.track.durationSec && Math.abs(audio.currentTime - expected) > 2.5) {
        try { audio.currentTime = expected } catch { /* ignore */ }
      }
    }, 3000)
    return () => clearInterval(iv)
  }, [now?.current])

  // Трек кончился → немедленно запросить следующий
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const onEnded = async () => {
      const d = await fetchNow()
      if (d) applySession(d)
    }
    audio.addEventListener('ended', onEnded)
    return () => audio.removeEventListener('ended', onEnded)
  }, [fetchNow, applySession])

  // Heartbeat слушателя
  useEffect(() => {
    let cid = localStorage.getItem('huk_uid')
    if (!cid) {
      cid = `u_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
      localStorage.setItem('huk_uid', cid)
    }
    const beat = () =>
      fetch('/api/radio/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: cid }),
      }).catch(() => {})
    beat()
    const iv = setInterval(beat, 10_000)
    return () => clearInterval(iv)
  }, [])

  const start = useCallback(async () => {
    wantPlayRef.current = true
    setUserStarted(true)
    const audio = audioRef.current
    if (!audio) return
    if (!audio.src) {
      const d = await fetchNow()
      if (d) applySession(d)
      return
    }
    const cur = now?.current
    if (cur) {
      const off = (Date.now() + skewRef.current - cur.startedAt) / 1000
      if (off > 0 && off < cur.track.durationSec) {
        try { audio.currentTime = off } catch { /* ignore */ }
      }
    }
    audio.play().catch(() => {})
  }, [now, fetchNow, applySession])

  const stop = useCallback(() => {
    wantPlayRef.current = false
    setUserStarted(false)
    setPlaying(false)
    audioRef.current?.pause()
  }, [])

  return { now, error, userStarted, playing, start, stop, audioRef, refetch: fetchNow }
}

// Получить uid из localStorage (для привязки загрузок)
export function getClientUid(): string {
  if (typeof window === 'undefined') return ''
  let uid = localStorage.getItem('huk_uid')
  if (!uid) {
    uid = `u_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
    localStorage.setItem('huk_uid', uid)
  }
  return uid
}
