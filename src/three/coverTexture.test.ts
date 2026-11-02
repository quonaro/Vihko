import { describe, it, expect } from 'vitest'
import {
  fitLines, coverCanvas, paintCover, dominantColorFromPixels,
} from './coverTexture'

const px = (s: string) => s.length * 10 // fake fixed-width measure

describe('fitLines', () => {
  it('wraps words at the max width', () => {
    // "travel notes" is 12 chars = 120px > 100px max, so it wraps.
    expect(fitLines('travel notes', px, 100)).toEqual(['travel', 'notes'])
  })

  it('keeps short titles on one line', () => {
    expect(fitLines('Идеи', px, 100)).toEqual(['Идеи'])
  })

  it('ellipsizes beyond maxLines', () => {
    const lines = fitLines('one two three four five', px, 60, 2)
    expect(lines).toHaveLength(2)
    expect(lines[1].endsWith('…')).toBe(true)
  })

  it('returns nothing for an empty title', () => {
    expect(fitLines('   ', px, 100)).toEqual([])
  })
})

describe('dominantColorFromPixels', () => {
  it('returns the most common opaque color', () => {
    expect(dominantColorFromPixels(new Uint8ClampedArray([
      40, 50, 60, 255,
      40, 50, 60, 255,
      220, 20, 30, 255,
      0, 0, 0, 0,
    ]))).toBe('#28323c')
  })

  it('ignores transparent pixels', () => {
    expect(dominantColorFromPixels(new Uint8ClampedArray([
      200, 10, 10, 0,
    ]))).toBe('#000000')
  })
})

describe('coverCanvas', () => {
  it('returns null where no 2D context exists (jsdom)', () => {
    expect(coverCanvas({ title: 'A', color: '#333' })).toBeNull()
  })
})

describe('paintCover', () => {
  // Records fillRect calls; covers must not paint a vertical strip past
  // the spine (the elastic band was removed from the design).
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

  it('paints no vertical strip other than the spine at x=0', () => {
    const canvas = { width: 384, height: 522 } as HTMLCanvasElement
    const { ctx, rects } = stubCtx()
    paintCover(canvas, ctx, { title: 'A', color: '#333' })
    expect(rects.length).toBeGreaterThan(0)
    expect(rects.every(([x]) => x === 0)).toBe(true)
  })

  it('adds a halftone print texture and a drawn cover border', () => {
    const canvas = { width: 384, height: 522 } as HTMLCanvasElement
    const arcs: number[][] = []
    let bordered = false
    const { ctx } = stubCtx()
    Object.assign(ctx, {
      arc: (...a: number[]) => arcs.push(a),
      strokeRect: () => { bordered = true },
    })
    paintCover(canvas, ctx, { title: 'A', color: '#333' })
    expect(arcs.length).toBeGreaterThan(100)
    expect(bordered).toBe(true)
  })
})
