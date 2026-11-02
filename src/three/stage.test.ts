import { afterEach, describe, expect, it, vi } from 'vitest'
import { detectQuality, FramePump, gridEdgeLoop } from './stage'

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

describe('gridEdgeLoop', () => {
  it('walks the grid perimeter once, every step a unit edge, ring closed', () => {
    const sx = 48
    const sy = 6
    const idx = gridEdgeLoop(sx, sy)
    const W = sx + 1
    expect(idx.length).toBe(2 * (sx + sy))
    expect(new Set(idx).size).toBe(idx.length)
    for (const i of idx) {
      const x = i % W
      const y = Math.floor(i / W)
      expect(x === 0 || y === 0 || x === sx || y === sy).toBe(true)
    }
    for (let k = 0; k < idx.length; k++) {
      const a = idx[k]
      const b = idx[(k + 1) % idx.length]
      const d = Math.abs((a % W) - (b % W)) + Math.abs(Math.floor(a / W) - Math.floor(b / W))
      expect(d).toBe(1)
    }
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
