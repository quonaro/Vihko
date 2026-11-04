import { describe, it, expect } from 'vitest'
import { coverCanvas, paintCover, dominantColorFromPixels } from './coverTexture'

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

  it('draws no cover border and no halftone dots', () => {
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
