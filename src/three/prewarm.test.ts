import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetSceneWarmup, scheduleSceneWarmup } from './prewarm'
import { warmJournalSurface } from './warmup'

vi.mock('./warmup', () => ({ warmJournalSurface: vi.fn(async () => {}) }))

const warm = vi.mocked(warmJournalSurface)

beforeEach(() => {
  resetSceneWarmup()
  warm.mockClear()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('scheduleSceneWarmup', () => {
  it('schedules one idle warmup no matter how many views ask for it', async () => {
    const idle: (() => void)[] = []
    vi.stubGlobal('requestIdleCallback', (cb: () => void) => idle.push(cb))

    scheduleSceneWarmup()
    scheduleSceneWarmup()
    scheduleSceneWarmup()
    await vi.advanceTimersByTimeAsync(600)

    expect(idle).toHaveLength(1)
    // Nothing is compiled until the browser actually reports idle.
    expect(warm).not.toHaveBeenCalled()

    idle[0]()
    await vi.waitFor(() => expect(warm).toHaveBeenCalledTimes(1))
  })

  it('falls back to a timer where idle callbacks are missing', async () => {
    scheduleSceneWarmup()
    await vi.advanceTimersByTimeAsync(600)
    expect(warm).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(600)
    await vi.waitFor(() => expect(warm).toHaveBeenCalledTimes(1))
  })

  it('can be reset for a fresh session', async () => {
    const idle: (() => void)[] = []
    vi.stubGlobal('requestIdleCallback', (cb: () => void) => idle.push(cb))
    scheduleSceneWarmup()
    await vi.advanceTimersByTimeAsync(600)
    resetSceneWarmup()
    scheduleSceneWarmup()
    await vi.advanceTimersByTimeAsync(600)
    expect(idle).toHaveLength(2)
  })
})
