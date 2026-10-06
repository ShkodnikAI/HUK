'use client'

import { useCallback, useState } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { AirTab } from '@/components/radio/air-tab'
import { UploadTab } from '@/components/radio/upload-tab'
import { ModerationTab } from '@/components/radio/moderation-tab'
import { Radio, UploadCloud, Gavel, Waves } from 'lucide-react'

export default function Home() {
  const [pendingCount, setPendingCount] = useState(0)
  const [refreshKey, setRefreshKey] = useState(0)

  const handleModerationCount = useCallback((n: number) => setPendingCount(n), [])

  return (
    <div className="flex min-h-screen flex-col bg-[#0a0a0c] text-zinc-100">
      {/* Шапка станции */}
      <header className="sticky top-0 z-20 border-b border-zinc-800/80 bg-[#0a0a0c]/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3.5 sm:px-6">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-500/15 ring-1 ring-amber-500/40">
              <Waves className="h-5 w-5 text-amber-400" />
            </div>
            <div>
              <h1 className="text-lg font-black leading-none tracking-tight text-zinc-50">
                HU<span className="text-amber-500">K</span>
              </h1>
              <p className="mt-0.5 text-[11px] leading-none text-zinc-500">
                круглоосуточное радио с ИИ-модерацией
              </p>
            </div>
          </div>
          <div className="hidden items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900/60 px-3 py-1.5 text-xs text-zinc-400 sm:flex">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-500" />
            вещание 24/7
          </div>
        </div>
      </header>

      {/* Контент */}
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6">
        <Tabs defaultValue="air" className="w-full">
          <TabsList className="mb-6 grid h-11 w-full max-w-md grid-cols-3 border border-zinc-800 bg-zinc-950/80">
            <TabsTrigger value="air" className="gap-1.5 data-[state=active]:bg-amber-500/15 data-[state=active]:text-amber-300">
              <Radio className="h-4 w-4" /> Эфир
            </TabsTrigger>
            <TabsTrigger value="upload" className="gap-1.5 data-[state=active]:bg-amber-500/15 data-[state=active]:text-amber-300">
              <UploadCloud className="h-4 w-4" /> Загрузить
            </TabsTrigger>
            <TabsTrigger value="moderation" className="gap-1.5 data-[state=active]:bg-amber-500/15 data-[state=active]:text-amber-300">
              <Gavel className="h-4 w-4" /> Модерация
              {pendingCount > 0 && (
                <span className="ml-0.5 inline-flex h-4.5 min-w-[18px] items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-bold text-zinc-950">
                  {pendingCount}
                </span>
              )}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="air">
            <AirTab onModerationCount={handleModerationCount} />
          </TabsContent>
          <TabsContent value="upload">
            <UploadTab />
          </TabsContent>
          <TabsContent value="moderation">
            <ModerationTab refreshKey={refreshKey} />
          </TabsContent>
        </Tabs>
      </main>

      {/* Футер — прижат к низу */}
      <footer className="mt-auto border-t border-zinc-800/80 bg-[#0a0a0c]">
        <div className="mx-auto max-w-6xl px-4 py-4 sm:px-6">
          <p className="text-xs leading-relaxed text-zinc-600">
            HUK · эфир ведёт виртуальная шкала времени, модерацию — ИИ-конвейер (транскрипция речи + политика станции),
            спорные треки решает человек. Сид-музыка генерируется процедурно и джинглы синтезированы — весь контент без копирайта.
          </p>
        </div>
      </footer>
    </div>
  )
}
