import { describe, it, expect } from 'vitest'
import { paintPage, pageCanvas, repaintInto, PAGE_ASPECT, PAGE_UNIT, SHEET_SHADE } from './pageTexture'
import { jsEngine } from '../ink/engine'
import { addJournal, openJournal, openPage, pushStroke } from '../store'
import type { InkEngine, Page } from '../types'

interface Op { name: string; args: unknown[] }
interface MockCtx {
  ops: Op[]
  fillStyle: unknown
  globalCompositeOperation: string
}

function makeCtx(): CanvasRenderingContext2D & MockCtx {
  const grad = { addColorStop() {} }
  const stack: { fillStyle: unknown; gco: string }[] = []
  const ctx: MockCtx & Record<string, unknown> = {
    ops: [],
    fillStyle: '#000',
    globalCompositeOperation: 'source-over',
    beginPath() { ctx.ops.push({ name: 'beginPath', args: [] }) },
    closePath() { ctx.ops.push({ name: 'closePath', args: [] }) },
    moveTo(...a: number[]) { ctx.ops.push({ name: 'moveTo', args: a }) },
    lineTo(...a: number[]) { ctx.ops.push({ name: 'lineTo', args: a }) },
    arc(...a: number[]) { ctx.ops.push({ name: 'arc', args: a }) },
    fill() { ctx.ops.push({ name: 'fill', args: [] }) },
    fillRect(...a: number[]) { ctx.ops.push({ name: 'fillRect', args: a }) },
    createRadialGradient() { return grad },
    createLinearGradient() { return grad },
    save() { stack.push({ fillStyle: ctx.fillStyle, gco: ctx.globalCompositeOperation }) },
    restore() {
      const s = stack.pop()
      if (s) {
        ctx.fillStyle = s.fillStyle
        ctx.globalCompositeOperation = s.gco
      }
    },
    setTransform(...a: number[]) { ctx.ops.push({ name: 'setTransform', args: a }) },
  }
  return ctx as unknown as CanvasRenderingContext2D & MockCtx
}

const ops = (ctx: MockCtx, name: string) => ctx.ops.filter((o) => o.name === name)

const page = (strokes: Page['strokes']): Page => ({ id: 'p', strokes, createdAt: 0 })

const line = (x0: number, x1: number): Page['strokes'][number] => ({
  tool: 'draw',
  color: '#22221f',
  pts: [
    { x: x0, y: 400, t: 0, p: 0.5 },
    { x: (x0 + x1) / 2, y: 400, t: 16, p: 0.5 },
    { x: x1, y: 400, t: 32, p: 0.5 },
  ],
})

const fakeCanvas = (w = 300) =>
  ({ width: w, height: Math.round(w * PAGE_ASPECT) }) as HTMLCanvasElement

describe('paintPage', () => {
  it('replays strokes through the ink engine at texture scale', () => {
    const ctx = makeCtx()
    paintPage(fakeCanvas(), ctx, page([line(100, 500)]), jsEngine())
    // strokes draw quads/arcs via renderSamples
    expect(ops(ctx, 'arc').length).toBeGreaterThan(0)
    // page-unit transform applied: canvas.width / PAGE_UNIT
    const scale = 300 / PAGE_UNIT
    const st = ops(ctx, 'setTransform').map((o) => o.args[0])
    expect(st).toContain(scale)
  })

  it('underlays the paper gradient with destination-over', () => {
    const ctx = makeCtx()
    const seen: string[] = []
    const orig = ctx.fillRect
    ctx.fillRect = (...a: number[]) => {
      seen.push(ctx.globalCompositeOperation)
      orig(a[0], a[1], a[2], a[3])
    }
    paintPage(fakeCanvas(), ctx, page([]), jsEngine())
    expect(seen[0]).toBe('destination-over')
    expect(ctx.globalCompositeOperation).toBe('source-over')
  })

  it('adds a centre fold shade when asked', () => {
    const ctx = makeCtx()
    paintPage(fakeCanvas(), ctx, page([]), jsEngine(), true)
    // paper underlay + two fold gradients = three fillRects
    expect(ops(ctx, 'fillRect')).toHaveLength(3)
    const plain = makeCtx()
    paintPage(fakeCanvas(), plain, page([]), jsEngine())
    expect(ops(plain, 'fillRect')).toHaveLength(1)
  })

  it('shades all four edges for fanned sheets', () => {
    const ctx = makeCtx()
    paintPage(fakeCanvas(), ctx, page([]), jsEngine(), undefined, true)
    // paper underlay + 4 edge gradients + 4 rim strips = nine fillRects
    expect(ops(ctx, 'fillRect')).toHaveLength(9)
    const plain = makeCtx()
    paintPage(fakeCanvas(), plain, page([]), jsEngine())
    expect(ops(plain, 'fillRect')).toHaveLength(1)
  })
})

describe('SHEET_SHADE', () => {
  it('is the shared resting+turning variant: fold plus edge shade', () => {
    expect(SHEET_SHADE).toEqual({ fold: true, edgeShade: true })
    const ctx = makeCtx()
    paintPage(fakeCanvas(), ctx, page([]), jsEngine(), SHEET_SHADE.fold, SHEET_SHADE.edgeShade)
    // paper underlay + 2 fold gradients + 4 edge gradients + 4 rim strips
    expect(ops(ctx, 'fillRect')).toHaveLength(11)
  })
})

describe('pageCanvas', () => {
  it('returns null when 2D context is unavailable (jsdom)', () => {
    expect(pageCanvas(page([]), jsEngine())).toBeNull()
  })
})

describe('cached content rasters', () => {
  const realGetContext = HTMLCanvasElement.prototype.getContext

  const fake2d = () => {
    const grad = { addColorStop() {} }
    const ctx: Record<string, unknown> = {
      fillStyle: '#000',
      globalAlpha: 1,
      globalCompositeOperation: 'source-over',
      save() {}, restore() {}, setTransform() {}, clearRect() {},
      drawImage() {}, fillRect() {},
      beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
      arc() {}, fill() {},
      createLinearGradient: () => grad,
      createRadialGradient: () => grad,
    }
    return ctx as unknown as CanvasRenderingContext2D
  }

  // One ink.begin() call per repainted stroke — a cheap repaint counter.
  const counting = (eng: InkEngine) => {
    let n = 0
    return {
      count: () => n,
      engine: {
        begin: (tool: string) => { n++; return eng.begin(tool) },
        addPoint: eng.addPoint,
        end: eng.end,
      } as InkEngine,
    }
  }

  const stubCanvas = () => {
    HTMLCanvasElement.prototype.getContext = (() =>
      fake2d()) as unknown as typeof HTMLCanvasElement.prototype.getContext
  }
  const unstubCanvas = () => {
    HTMLCanvasElement.prototype.getContext = realGetContext
  }

  it('reuses the base raster across variants until the page revision bumps', () => {
    stubCanvas()
    try {
      const spy = counting(jsEngine())
      const j = addJournal()
      const p = j.pages[0]
      openJournal(j.id)
      openPage(p.id)
      pushStroke(line(0, 200))
      pageCanvas(p, spy.engine, 300)
      pageCanvas(p, spy.engine, 300, true)
      expect(spy.count()).toBe(1) // second variant reused the cached base
      pushStroke(line(0, 100))
      pageCanvas(p, spy.engine, 300)
      expect(spy.count()).toBe(3) // content changed -> repaint of both strokes
    } finally {
      unstubCanvas()
    }
  })

  it('repaintInto leaves the base alone unless forced', () => {
    stubCanvas()
    try {
      const spy = counting(jsEngine())
      const j = addJournal()
      const p = j.pages[0]
      openJournal(j.id)
      openPage(p.id)
      pushStroke(line(0, 200))
      const c = pageCanvas(p, spy.engine, 300)!
      const ctx = c.getContext('2d')!
      repaintInto(ctx, c, p, spy.engine)
      expect(spy.count()).toBe(1)
      repaintInto(ctx, c, p, spy.engine, undefined, undefined, true)
      expect(spy.count()).toBe(2)
    } finally {
      unstubCanvas()
    }
  })
})
