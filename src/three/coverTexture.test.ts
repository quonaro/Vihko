import { describe, it, expect, vi } from 'vitest'
import { coverCanvas, coverWidth, paintCover, dominantColorFromPixels } from './coverTexture'

describe('dominantColorFromPixels', () => {
  it('returns the most common opaque color', () => {
    expect(
      dominantColorFromPixels(
        new Uint8ClampedArray([40, 50, 60, 255, 40, 50, 60, 255, 220, 20, 30, 255, 0, 0, 0, 0]),
      ),
    ).toBe('#28323c')
  })

  it('ignores transparent pixels', () => {
    expect(dominantColorFromPixels(new Uint8ClampedArray([200, 10, 10, 0]))).toBe('#000000')
  })
})

describe('coverCanvas', () => {
  it('returns null where no 2D context exists (jsdom)', () => {
    expect(coverCanvas({ color: '#333' })).toBeNull()
  })
})

describe('coverWidth', () => {
  it('follows the cover-quality setting, defaulting to medium', () => {
    expect(coverWidth()).toBe(768)
    localStorage.setItem('vihko:cover-quality', 'low')
    expect(coverWidth()).toBe(384)
    localStorage.setItem('vihko:cover-quality', 'high')
    expect(coverWidth()).toBe(1024)
    localStorage.setItem('vihko:cover-quality', 'ultra')
    expect(coverWidth()).toBe(1536)
    localStorage.removeItem('vihko:cover-quality')
  })
})

describe('paintCover', () => {
  // Records fillRect calls; covers must not paint a vertical strip at all
  // (spine strip and elastic band were removed from the design).
  function stubCtx() {
    const rects: number[][] = []
    const ctx = {
      clearRect: () => {},
      fillRect: (...a: number[]) => rects.push(a),
      drawImage: () => {},
      fillText: () => {},
      beginPath: () => {},
      arc: () => {},
      fill: () => {},
      strokeRect: () => {},
      measureText: (s: string) => ({ width: s.length * 10 }),
      createLinearGradient: () => ({ addColorStop: () => {} }),
    } as unknown as CanvasRenderingContext2D
    return { ctx, rects }
  }

  it('paints only full-width fills — no spine strip', () => {
    const canvas = { width: 384, height: 522 } as HTMLCanvasElement
    const { ctx, rects } = stubCtx()
    paintCover(canvas, ctx, { color: '#333' })
    expect(rects.length).toBeGreaterThan(0)
    expect(rects.every(([x, , w]) => x === 0 && w === canvas.width)).toBe(true)
  })

  it('does not paint a directional gloss gradient', () => {
    const canvas = { width: 384, height: 522 } as HTMLCanvasElement
    let gradients = 0
    const { ctx } = stubCtx()
    Object.assign(ctx, {
      createLinearGradient: () => {
        gradients++
        return { addColorStop: () => {} }
      },
    })
    paintCover(canvas, ctx, { color: '#333' })
    expect(gradients).toBe(0)
  })

  it('keeps the paper texture free of comic dots and a cover border', () => {
    const canvas = { width: 384, height: 522 } as HTMLCanvasElement
    const arcs: number[][] = []
    let bordered = false
    const { ctx } = stubCtx()
    Object.assign(ctx, {
      arc: (...a: number[]) => arcs.push(a),
      strokeRect: () => {
        bordered = true
      },
    })
    paintCover(canvas, ctx, { color: '#333' })
    expect(arcs.length).toBe(0)
    expect(bordered).toBe(false)
  })

  it('uses the earlier lower-cover comic halftone treatment', () => {
    const canvas = { width: 384, height: 522 } as HTMLCanvasElement
    const arcs: number[][] = []
    const alphas: number[] = []
    const { ctx } = stubCtx()
    Object.assign(ctx, {
      arc: (...a: number[]) => arcs.push(a),
      fill: () => alphas.push(ctx.globalAlpha),
    })
    paintCover(canvas, ctx, { color: '#333', coverTexture: 'comic' })
    expect(arcs.length).toBeGreaterThan(400)
    expect(arcs[0]).toEqual([10, 303, 1.8, 0, Math.PI * 2])
    expect(alphas[0]).toBeCloseTo(0.16)
    expect(alphas[alphas.length - 1]).toBeGreaterThan(alphas[0])
    expect(ctx.globalAlpha).toBe(1)
  })

  // Must run before any grain-applying paintCover call: the grain tile is
  // module-cached, so only the first attempt creates a canvas element.
  it('keeps paper grain off photo covers', () => {
    const createElement = vi.spyOn(document, 'createElement')
    try {
      const canvas = { width: 384, height: 522 } as HTMLCanvasElement
      const { ctx } = stubCtx()
      Object.assign(ctx, { createPattern: () => null })
      paintCover(canvas, ctx, { color: '#333', coverImg: 'data:image/png;base64,x' })
      expect(createElement).not.toHaveBeenCalled()
    } finally {
      createElement.mockRestore()
    }
  })

  it('still applies paper grain to plain covers', () => {
    const createElement = vi.spyOn(document, 'createElement')
    try {
      const canvas = { width: 384, height: 522 } as HTMLCanvasElement
      const { ctx } = stubCtx()
      Object.assign(ctx, { createPattern: () => null })
      paintCover(canvas, ctx, { color: '#333' })
      expect(createElement).toHaveBeenCalledWith('canvas')
    } finally {
      createElement.mockRestore()
    }
  })

  it('paints no title text — the shelf labels books below instead', () => {
    const canvas = { width: 384, height: 522 } as HTMLCanvasElement
    let textDrawn = false
    const { ctx } = stubCtx()
    Object.assign(ctx, {
      fillText: () => {
        textDrawn = true
      },
    })
    paintCover(canvas, ctx, { color: '#333' })
    expect(textDrawn).toBe(false)
  })
})
