'use client'

import { useEffect, useRef } from 'react'

// Спектр-визуализатор: Web Audio AnalyserNode + canvas.
// До подключения анализатора рисует «дышащую» idle-волну.
export function Visualizer({
  audioRef,
  active,
  className,
}: {
  audioRef: React.RefObject<HTMLAudioElement | null>
  active: boolean
  className?: string
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const ctxAudioRef = useRef<AudioContext | null>(null)
  const rafRef = useRef(0)
  const phaseRef = useRef(0)

  // Построение аудиографа при первом включении
  useEffect(() => {
    if (!active || !audioRef.current || analyserRef.current || ctxAudioRef.current) return
    try {
      const ctx = new AudioContext()
      const src = ctx.createMediaElementSource(audioRef.current)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      analyser.smoothingTimeConstant = 0.82
      src.connect(analyser)
      analyser.connect(ctx.destination)
      ctxAudioRef.current = ctx
      analyserRef.current = analyser
      void ctx.resume()
    } catch {
      // без анализатора — idle-анимация
    }
  }, [active, audioRef])

  // resume контекста на play
  useEffect(() => {
    if (active && ctxAudioRef.current?.state === 'suspended') {
      void ctxAudioRef.current.resume()
    }
  }, [active])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const c2d = canvas.getContext('2d')
    if (!c2d) return

    const draw = () => {
      const w = canvas.width
      const h = canvas.height
      c2d.clearRect(0, 0, w, h)
      const bars = 48
      const gap = 3
      const bw = (w - gap * (bars - 1)) / bars
      const analyser = analyserRef.current
      const playing = active && analyser

      const heights: number[] = []
      if (playing) {
        const data = new Uint8Array(analyser.frequencyBinCount)
        analyser.getByteFrequencyData(data)
        const step = Math.floor(data.length / bars) || 1
        for (let i = 0; i < bars; i++) {
          let sum = 0
          for (let k = 0; k < step; k++) sum += data[i * step + k] ?? 0
          heights.push((sum / step / 255) ** 0.9)
        }
      } else {
        phaseRef.current += 0.02
        for (let i = 0; i < bars; i++) {
          heights.push(
            0.06 + 0.05 * Math.abs(Math.sin(phaseRef.current + i * 0.35)) * Math.sin(phaseRef.current * 0.4 + i * 0.05)
          )
        }
      }

      for (let i = 0; i < bars; i++) {
        const v = Math.max(0.02, Math.min(1, heights[i]))
        const bh = Math.max(3, v * (h - 8))
        const x = i * (bw + gap)
        const y = h - bh
        const grad = c2d.createLinearGradient(0, y, 0, h)
        if (i % 6 === 5) {
          grad.addColorStop(0, 'rgba(79, 209, 197, 0.95)')
          grad.addColorStop(1, 'rgba(79, 209, 197, 0.25)')
        } else {
          grad.addColorStop(0, 'rgba(245, 158, 11, 0.98)')
          grad.addColorStop(1, 'rgba(245, 158, 11, 0.22)')
        }
        c2d.fillStyle = grad
        const r = Math.min(3, bw / 2)
        c2d.beginPath()
        c2d.roundRect(x, y, bw, bh, r)
        c2d.fill()
      }
      rafRef.current = requestAnimationFrame(draw)
    }
    rafRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(rafRef.current)
  }, [active])

  return (
    <canvas
      ref={canvasRef}
      width={720}
      height={96}
      className={className}
      aria-hidden="true"
    />
  )
}
