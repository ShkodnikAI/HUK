// Учёт слушателей: heartbeat-окно 30 секунд, чисто in-memory

const WINDOW_MS = 30_000

const listeners = new Map<string, number>()

export function touchListener(clientId: string): number {
  const now = Date.now()
  listeners.set(clientId, now)
  // мягкая зачистка устаревших записей
  if (listeners.size > 500) {
    for (const [id, seen] of listeners) {
      if (now - seen > WINDOW_MS) listeners.delete(id)
    }
  }
  return countListeners()
}

export function countListeners(): number {
  const now = Date.now()
  let count = 0
  for (const seen of listeners.values()) {
    if (now - seen <= WINDOW_MS) count++
  }
  return count
}
