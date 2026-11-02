import { afterEach, describe, expect, it, vi } from 'vitest'
import { detectQuality, FramePump } from './stage'

describe('3D quality profile', () => {
  afterEach(() => {
    localStorage.removeItem('vihko:gl-quality')
    vi.restoreAllMocks()
  })

  it('uses the coarse-pointer profile by default', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: true,
    } as MediaQueryList)
    expect(detectQuality()).toBe('low')
  })

  it('allows an explicit quality override', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: true,
    } as MediaQueryList)
    localStorage.setItem('vihko:gl-quality', 'high')
    expect(detectQuality()).toBe('high')
  })

  it('ignores invalid overrides and falls back to the device profile', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: false,
    } as MediaQueryList)
    localStorage.setItem('vihko:gl-quality', 'potato')
    expect(detectQuality()).toBe('high')
  })
})

describe('FramePump', () => {
  it('runs until the scene reports idle, then resumes on wake', async () => {
    const queued: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      queued.push(cb)
      return queued.length
    })
    const frame = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValue(false)
    const pump = new FramePump(frame)
    const draw = () => queued.shift()?.(16)

    pump.start()
    draw()
    draw()
    expect(frame).toHaveBeenCalledTimes(2)

    expect(frame).toHaveBeenCalledTimes(2)

    pump.wake()
    draw()
    expect(frame).toHaveBeenCalledTimes(3)
    pump.stop()
  })

  it('does not run a pending frame after stop', () => {
    const queued: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      queued.push(cb)
      return queued.length
    })
    const frame = vi.fn().mockReturnValue(true)
    const pump = new FramePump(frame)
    pump.start()
    pump.stop()
    queued.shift()?.(16)
    expect(frame).not.toHaveBeenCalled()
  })
})
