import { describe, it, expect } from 'vitest'
import { renderSamples } from './renderer'
import type { Sample, ToolId } from '../types'

interface Op {
  name: string
  args: unknown[]
}
interface MockCtx {
  ops: Op[]
  fillStyle: unknown
  globalAlpha: number
  globalCompositeOperation: string
}

function makeCtx(): CanvasRenderingContext2D & MockCtx {
  const grad = {
    stops: [] as [number, string][],
    addColorStop(o: number, c: string) {
      this.stops.push([o, c])
    },
  }
  const ctx: MockCtx & Record<string, unknown> = {
    ops: [],
    fillStyle: '#000',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    grad,
    beginPath() {
      ctx.ops.push({ name: 'beginPath', args: [] })
    },
    closePath() {
      ctx.ops.push({ name: 'closePath', args: [] })
    },
    moveTo(...a: number[]) {
      ctx.ops.push({ name: 'moveTo', args: a })
    },
    lineTo(...a: number[]) {
      ctx.ops.push({ name: 'lineTo', args: a })
    },
    arc(...a: number[]) {
      ctx.ops.push({ name: 'arc', args: a })
    },
    fill() {
      ctx.ops.push({ name: 'fill', args: [] })
    },
    createRadialGradient(...a: number[]) {
      ctx.ops.push({ name: 'createRadialGradient', args: a })
      return grad
    },
  }
  return ctx as unknown as CanvasRenderingContext2D & MockCtx
}

const ops = (ctx: MockCtx, name: string) => ctx.ops.filter((o) => o.name === name)

const stroke = (...xs: number[]): Sample[] => xs.map((x) => ({ x, y: 10, w: 2, a: 0.9 }))

describe('renderSamples', () => {
  it('does nothing for an empty stroke', () => {
    const ctx = makeCtx()
    renderSamples(ctx, 'draw', '#22221f', [])
    expect(ctx.ops).toEqual([])
  })

  it('solid painter: round cap + quads between samples', () => {
    const ctx = makeCtx()
    renderSamples(ctx, 'draw', '#22221f', stroke(0, 5, 10))
    expect(ctx.fillStyle).toBe('rgba(34,34,31,1)')
    // 1 cap joint + 2 quads + 2 joints
    expect(ops(ctx, 'arc')).toHaveLength(3)
    expect(ops(ctx, 'moveTo')).toHaveLength(2)
    expect(ops(ctx, 'lineTo')).toHaveLength(6)
    expect(ops(ctx, 'fill').length).toBeGreaterThanOrEqual(5)
  })

  it('single sample draws only the round cap', () => {
    const ctx = makeCtx()
    renderSamples(ctx, 'write', '#000000', stroke(0))
    expect(ops(ctx, 'arc')).toHaveLength(1)
    expect(ops(ctx, 'moveTo')).toHaveLength(0)
  })

  it('scales brush sample widths without changing the stored geometry', () => {
    const ctx = makeCtx()
    const samples = stroke(0)
    renderSamples(ctx, 'write', '#000000', samples, 1, 2.5)
    expect(ops(ctx, 'arc')[0].args[2]).toBe(5)
    expect(samples[0].w).toBe(2)
  })

  it('applies per-sample alpha then restores globalAlpha', () => {
    const ctx = makeCtx()
    renderSamples(ctx, 'draw', '#ffffff', stroke(0, 1, 2))
    expect(ctx.globalAlpha).toBe(1)
  })

  it('default branch covers non-special tools', () => {
    for (const tool of ['draw', 'write', 'outline'] as ToolId[]) {
      const ctx = makeCtx()
      renderSamples(ctx, tool, '#123456', stroke(0, 5))
      expect(ctx.fillStyle).toBe('rgba(18,52,86,1)')
    }
  })

  it('eraser uses destination-out and restores the composite op', () => {
    const ctx = makeCtx()
    const seen: string[] = []
    const orig = ctx.fill
    ctx.fill = () => {
      seen.push(ctx.globalCompositeOperation)
      orig()
    }
    renderSamples(ctx, 'eraser', '#ffffff', stroke(0, 5))
    expect(ctx.fillStyle).toBe('#000')
    expect(seen.every((c) => c === 'destination-out')).toBe(true)
    expect(ctx.globalCompositeOperation).toBe('source-over')
  })

  it('watercolor multiplies radial-gradient stamps and restores', () => {
    const ctx = makeCtx()
    renderSamples(ctx, 'color', '#4a6b8a', stroke(0, 20))
    expect(ops(ctx, 'createRadialGradient').length).toBeGreaterThan(0)
    expect(ctx.globalCompositeOperation).toBe('source-over')
    const grad = (ctx as unknown as { grad: { stops: [number, string][] } }).grad
    expect(grad.stops[0][1]).toContain('rgba(74,107,138,')
    expect(grad.stops.at(-1)![1]).toContain(',0)')
  })

  it('pencil is deterministic for a fixed seed', () => {
    const a = makeCtx()
    const b = makeCtx()
    renderSamples(a, 'sketch', '#333333', stroke(0, 8, 16), 7)
    renderSamples(b, 'sketch', '#333333', stroke(0, 8, 16), 7)
    expect(JSON.stringify(a.ops)).toBe(JSON.stringify(b.ops))
  })

  it('pencil jitter differs across seeds', () => {
    const a = makeCtx()
    const b = makeCtx()
    renderSamples(a, 'sketch', '#333333', stroke(0, 8, 16, 24), 1)
    renderSamples(b, 'sketch', '#333333', stroke(0, 8, 16, 24), 99)
    expect(JSON.stringify(a.ops)).not.toBe(JSON.stringify(b.ops))
  })

  it('accepts 3-digit hex colors', () => {
    const ctx = makeCtx()
    renderSamples(ctx, 'draw', '#fff', stroke(0))
    expect(ctx.fillStyle).toBe('rgba(255,255,255,1)')
  })
})
