import { describe, it, expect, vi, afterEach } from 'vitest'
import { morphTo, centeredRect, fullRect } from './anim'

describe('rect helpers', () => {
  it('fullRect covers the whole window', () => {
    expect(fullRect()).toEqual({
      left: 0, top: 0,
      width: window.innerWidth, height: window.innerHeight,
    })
  })

  it('centeredRect is capped and centered', () => {
    const r = centeredRect(0.86)
    const w = Math.min(window.innerWidth * 0.86, 900)
    const h = Math.min(window.innerHeight * 0.86, 700)
    expect(r.width).toBe(w)
    expect(r.height).toBe(h)
    expect(r.left).toBeCloseTo((window.innerWidth - w) / 2)
    expect(r.top).toBeCloseTo((window.innerHeight - h) / 2)
  })
})

describe('morphTo', () => {
  afterEach(() => {
    document.querySelectorAll('.morph').forEach((el) => el.remove())
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('clones the source rect into a .morph overlay and removes it', () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      setTimeout(() => cb(0), 0)
      return 0
    })
    const src = document.createElement('div')
    document.body.appendChild(src)

    morphTo({ left: 10, top: 20, width: 200, height: 100 }, src)

    const clone = document.querySelector<HTMLElement>('.morph')
    expect(clone).not.toBeNull()
    expect(clone!.style.left).toBe('0px') // jsdom rects are zeroed
    expect(clone!.style.boxShadow).toContain('0 24px 70px')

    vi.advanceTimersByTime(1) // double rAF -> target state applied
    // (jsdom's CSSOM drops `transform`, so assert the sibling props instead)
    expect(clone!.style.opacity).toBe('0')
    expect(clone!.style.borderRadius).toBe('4px')

    vi.advanceTimersByTime(400)
    expect(document.querySelector('.morph')).toBeNull()
    src.remove()
  })
})
