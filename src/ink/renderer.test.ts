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
  const stack: [string, number][] = []
  const ctx: MockCtx & Record<string, unknown> = {
    ops: [],
    fillStyle: '#000',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    grad,
    save() {
      stack.push([ctx.globalCompositeOperation, ctx.globalAlpha])
    },
    restore() {
      const st = stack.pop()
      if (st) {
        ctx.globalCompositeOperation = st[0]
        ctx.globalAlpha = st[1]
      }
    },
    drawImage() {
      ctx.ops.push({ name: 'drawImage', args: [] })
    },
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

  it('solid painter: one outline polygon + round caps', () => {
    const ctx = makeCtx()
    renderSamples(ctx, 'draw', '#22221f', stroke(0, 5, 10))
    expect(ctx.fillStyle).toBe('rgb(34,34,31)')
    // one polygon (3 left + 2 right points) + 2 cap joints
    expect(ops(ctx, 'arc')).toHaveLength(2)
    expect(ops(ctx, 'moveTo')).toHaveLength(1)
    expect(ops(ctx, 'lineTo')).toHaveLength(5)
    expect(ops(ctx, 'fill')).toHaveLength(3)
  })

  it('single sample draws only the round cap', () => {
    const ctx = makeCtx()
    renderSamples(ctx, 'write', '#000000', stroke(0))
    expect(ops(ctx, 'arc')).toHaveLength(1)
    expect(ops(ctx, 'moveTo')).toHaveLength(1) // degenerate outline, no fill area
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
      expect(ctx.fillStyle).toBe('rgb(18,52,86)')
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
    expect(ctx.fillStyle).toBe('rgb(255,255,255)')
  })
})

describe('brush options', () => {
  it('opacity scales sample alpha and restores it', () => {
    const ctx = makeCtx()
    renderSamples(ctx, 'draw', '#22221f', stroke(0), 1, 1, { opacity: 0.5 })
    expect(ctx.globalCompositeOperation).toBe('source-over')
    // globalAlpha is restored to 1 after painting
    expect(ctx.globalAlpha).toBe(1)
  })

  it('blend applies the stroke composite operation', () => {
    const ctx = makeCtx()
    renderSamples(ctx, 'draw', '#22221f', stroke(0), 1, 1, { blend: 'multiply' })
    expect(ctx.globalCompositeOperation).toBe('source-over') // restored
  })

  it('texture tip falls back to the solid painter without a canvas backend', () => {
    const ctx = makeCtx()
    renderSamples(ctx, 'draw', '#22221f', stroke(0, 5), 1, 1, { tip: 'airbrush' })
    // jsdom has no 2d backend -> stampSprite returns null -> solid outline
    expect(ops(ctx, 'lineTo').length).toBeGreaterThan(0)
  })

  it('eraser with a texture tip stays on destination-out fallback', () => {
    const ctx = makeCtx()
    renderSamples(ctx, 'eraser', '#fff', stroke(0, 5), 1, 1, { tip: 'noise' })
    expect(ops(ctx, 'fill').length).toBeGreaterThan(0)
  })
})
