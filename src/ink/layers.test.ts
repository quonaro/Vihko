import { describe, expect, it, vi } from 'vitest'
import { PAGE_H, PAGE_W } from '../pageSpace'
import type { InkEngine, Layer, Page } from '../types'
import {
  adoptLayerRasterTail,
  clearLayerRasterCache,
  cutOpForLayer,
  layerRasterCanvas,
  paintLayers,
} from './layers'

describe('cutOpForLayer', () => {
  it('maps a world-space selection and drag into transformed layer coordinates', () => {
    const layer: Layer = {
      id: 'layer',
      name: 'Layer',
      visible: true,
      opacity: 1,
      x: 10,
      y: 20,
      scale: 2,
      rotation: 90,
    }
    const op = cutOpForLayer(
      {
        kind: 'cut',
        path: [{ x: PAGE_W / 2 + 10 - 12, y: PAGE_H / 2 + 20 + 8 }],
        dx: -6,
        dy: 10,
        after: 0,
        layerId: '*',
      },
      layer,
    )

    expect(op.path[0].x).toBeCloseTo(PAGE_W / 2 + 4)
    expect(op.path[0].y).toBeCloseTo(PAGE_H / 2 + 6)
    expect(op.dx).toBeCloseTo(5)
    expect(op.dy).toBeCloseTo(3)
  })

  it('replays a global raster operation on every layer', () => {
    const layers: Layer[] = ['lower', 'upper'].map((id) => ({
      id,
      name: id,
      visible: true,
      opacity: 1,
      x: 0,
      y: 0,
      scale: 1,
      rotation: 0,
    }))
    const page: Page = {
      id: 'page',
      strokes: [],
      layers,
      createdAt: 0,
      ops: [{ kind: 'clear', after: 0, layerId: '*' }],
    }
    const ctx = {
      save: () => {},
      restore: () => {},
      setTransform: () => {},
      beginPath: () => {},
      rect: () => {},
      clip: () => {},
      clearRect: vi.fn(),
    } as unknown as CanvasRenderingContext2D

    paintLayers({ width: 100, height: 100 } as HTMLCanvasElement, ctx, page, {} as InkEngine, 1)

    expect(ctx.clearRect).toHaveBeenCalledTimes(2)
  })

  it('replays a layer-scoped raster operation only on its target layer', () => {
    const layers: Layer[] = ['lower', 'upper'].map((id) => ({
      id,
      name: id,
      visible: true,
      opacity: 1,
      x: 0,
      y: 0,
      scale: 1,
      rotation: 0,
    }))
    const page: Page = {
      id: 'page',
      strokes: [],
      layers,
      createdAt: 0,
      ops: [{ kind: 'clear', after: 0, layerId: 'upper' }],
    }
    const ctx = {
      save: () => {},
      restore: () => {},
      setTransform: () => {},
      beginPath: () => {},
      rect: () => {},
      clip: () => {},
      clearRect: vi.fn(),
    } as unknown as CanvasRenderingContext2D

    paintLayers({ width: 100, height: 100 } as HTMLCanvasElement, ctx, page, {} as InkEngine, 1)

    expect(ctx.clearRect).toHaveBeenCalledTimes(1)
  })

  it('clips a focused-half stroke to its recorded polygon in local units', () => {
    const rasterCtx = stubCtx()
    const compositeCtx = stubCtx()
    const createElement = vi
      .spyOn(document, 'createElement')
      .mockImplementation(() => stubCanvas(rasterCtx))
    const layer = stubLayer('L')
    const clip = [
      { x: 10, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 200 },
      { x: 10, y: 200 },
    ]
    const page: Page = {
      id: 'clip-stroke-page',
      strokes: [
        {
          tool: 'write',
          color: '#111',
          pts: [{ x: 20, y: 20, t: 0, p: 0.5 }],
          layerId: 'L',
          clip,
        },
      ],
      layers: [layer],
      createdAt: 0,
    }
    const ink = stubInk()

    clearLayerRasterCache(page.id)
    try {
      paintLayers(stubCanvas(compositeCtx), compositeCtx, page, ink, 1)
      expect(rasterCtx.clip).toHaveBeenCalled()
      // pathTo draws the polygon in layer-local units — the raster
      // transform already carries the scale, so no double scaling.
      expect(rasterCtx.moveTo).toHaveBeenCalledWith(10, 0)
      expect(rasterCtx.lineTo).toHaveBeenCalledWith(50, 0)
    } finally {
      clearLayerRasterCache(page.id)
      createElement.mockRestore()
    }
  })

  it('reuses layer contents when only the layer transform changes', () => {
    const rasterCtx = {
      setTransform: vi.fn(),
      clearRect: vi.fn(),
    } as unknown as CanvasRenderingContext2D
    const compositeCtx = {
      save: vi.fn(),
      restore: vi.fn(),
      setTransform: vi.fn(),
      beginPath: vi.fn(),
      rect: vi.fn(),
      clip: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      scale: vi.fn(),
      drawImage: vi.fn(),
      globalAlpha: 1,
    } as unknown as CanvasRenderingContext2D
    const raster = {
      getContext: () => rasterCtx,
    } as unknown as HTMLCanvasElement
    const createElement = vi.spyOn(document, 'createElement').mockReturnValue(raster)
    const layer: Layer = {
      id: 'cache-test',
      name: 'Layer',
      visible: true,
      opacity: 1,
      x: 0,
      y: 0,
      scale: 1,
      rotation: 0,
    }
    const page: Page = {
      id: 'cache-test-page',
      strokes: [],
      layers: [layer],
      createdAt: 0,
    }

    clearLayerRasterCache(page.id)
    try {
      paintLayers(raster, compositeCtx, page, {} as InkEngine, 1)
      layer.x = 24
      layer.rotation = 18
      paintLayers(raster, compositeCtx, page, {} as InkEngine, 1)

      expect(rasterCtx.clearRect).toHaveBeenCalledTimes(1)
      expect(compositeCtx.drawImage).toHaveBeenCalledTimes(2)
    } finally {
      clearLayerRasterCache(page.id)
      createElement.mockRestore()
    }
  })
})

// Mock 2d contexts: every method stubbed, globalCompositeOperation changes
// recorded into `rec` (shared across contexts so masked composites show up).
function stubCtx(rec?: { gco?: string[]; blends?: string[] }) {
  let gco = 'source-over'
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    setTransform: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    scale: vi.fn(),
    clearRect: vi.fn(),
    clip: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    arc: vi.fn(),
    rect: vi.fn(),
    fill: vi.fn(),
    drawImage: vi.fn(function (this: { globalCompositeOperation: string }) {
      rec?.blends?.push(this.globalCompositeOperation)
    }),
    globalAlpha: 1,
    fillStyle: '',
    get globalCompositeOperation() {
      return gco
    },
    set globalCompositeOperation(v: string) {
      gco = v
      rec?.gco?.push(v)
    },
  }
  return ctx as unknown as CanvasRenderingContext2D
}

const stubCanvas = (ctx: CanvasRenderingContext2D) =>
  ({ width: 0, height: 0, getContext: () => ctx }) as unknown as HTMLCanvasElement

const stubInk = (): InkEngine => ({
  begin: () => 1,
  addPoint: () => [{ x: 0, y: 0, w: 3, a: 1 }],
  predict: () => [],
  tail: () => [],
  end: () => [{ x: 1, y: 1, w: 3, a: 1 }],
})

const stubLayer = (id: string, extra: Partial<Layer> = {}): Layer => ({
  id,
  name: id,
  visible: true,
  opacity: 1,
  x: 0,
  y: 0,
  scale: 1,
  rotation: 0,
  ...extra,
})

describe('layer raster cache (fixed resolution)', () => {
  it('reuses the same raster across zoom levels', () => {
    const rasterCtx = stubCtx()
    const compositeCtx = stubCtx()
    const createElement = vi
      .spyOn(document, 'createElement')
      .mockImplementation(() => stubCanvas(rasterCtx))
    const page: Page = {
      id: 'fixed-res',
      strokes: [],
      layers: [stubLayer('L')],
      createdAt: 0,
    }

    clearLayerRasterCache(page.id)
    try {
      paintLayers(stubCanvas(compositeCtx), compositeCtx, page, stubInk(), 1)
      paintLayers(stubCanvas(compositeCtx), compositeCtx, page, stubInk(), 8)

      // One rasterization for both zoom levels, at the fixed raster width.
      expect(rasterCtx.clearRect).toHaveBeenCalledTimes(1)
      expect(createElement.mock.results[0].value.width).toBe(3072)
      expect(compositeCtx.drawImage).toHaveBeenCalledTimes(2)
    } finally {
      clearLayerRasterCache(page.id)
      createElement.mockRestore()
    }
  })

  it('paints only appended strokes into the cached raster instead of re-replaying', () => {
    const rasterCtx = stubCtx()
    const compositeCtx = stubCtx()
    const createElement = vi
      .spyOn(document, 'createElement')
      .mockImplementation(() => stubCanvas(rasterCtx))
    const page: Page = {
      id: 'append-page',
      strokes: [
        { tool: 'write', color: '#111', pts: [{ x: 0, y: 0, t: 0, p: 0.5 }], layerId: 'L' },
      ],
      layers: [stubLayer('L')],
      createdAt: 0,
    }
    const ink = stubInk()
    const beginSpy = vi.spyOn(ink, 'begin')

    clearLayerRasterCache(page.id)
    try {
      paintLayers(stubCanvas(compositeCtx), compositeCtx, page, ink, 1)
      expect(beginSpy).toHaveBeenCalledTimes(1)
      expect(rasterCtx.clearRect).toHaveBeenCalledTimes(1)

      // Appending a stroke extends the raster incrementally — no clear, and
      // only the new stroke is replayed through the engine.
      page.strokes.push({
        tool: 'write',
        color: '#222',
        pts: [{ x: 1, y: 1, t: 1, p: 0.5 }],
        layerId: 'L',
      })
      paintLayers(stubCanvas(compositeCtx), compositeCtx, page, ink, 1)
      expect(rasterCtx.clearRect).toHaveBeenCalledTimes(1)
      expect(beginSpy).toHaveBeenCalledTimes(2)

      page.ops = [{ kind: 'clear', after: 2, layerId: 'L' }]
      paintLayers(stubCanvas(compositeCtx), compositeCtx, page, ink, 1)
      expect(rasterCtx.clearRect).toHaveBeenCalledTimes(2) // the appended clear op
      expect(beginSpy).toHaveBeenCalledTimes(2)
    } finally {
      clearLayerRasterCache(page.id)
      createElement.mockRestore()
    }
  })

  it('adopts a stroke painted live into the raster without re-rendering it', () => {
    const rasterCtx = stubCtx()
    const compositeCtx = stubCtx()
    const createElement = vi
      .spyOn(document, 'createElement')
      .mockImplementation(() => stubCanvas(rasterCtx))
    const layer = stubLayer('L')
    const page: Page = {
      id: 'adopt-page',
      strokes: [
        { tool: 'write', color: '#111', pts: [{ x: 0, y: 0, t: 0, p: 0.5 }], layerId: 'L' },
      ],
      layers: [layer],
      createdAt: 0,
    }
    const ink = stubInk()
    const beginSpy = vi.spyOn(ink, 'begin')

    clearLayerRasterCache(page.id)
    try {
      const raster = layerRasterCanvas(page, ink, 'L')!
      expect(beginSpy).toHaveBeenCalledTimes(1)

      // A live stroke painted straight into the cached raster: push it to
      // the model and adopt the signature — the next composite must not
      // replay it through the engine.
      page.strokes.push({
        tool: 'write',
        color: '#222',
        pts: [{ x: 1, y: 1, t: 1, p: 0.5 }],
        layerId: 'L',
      })
      expect(adoptLayerRasterTail(page, layer, raster)).toBe(true)
      paintLayers(stubCanvas(compositeCtx), compositeCtx, page, ink, 1)
      expect(beginSpy).toHaveBeenCalledTimes(1)
      expect(rasterCtx.clearRect).toHaveBeenCalledTimes(1)

      // A different canvas means the entry was rebuilt under us — no adopt.
      expect(adoptLayerRasterTail(page, layer, { width: 0 } as HTMLCanvasElement)).toBe(false)
    } finally {
      clearLayerRasterCache(page.id)
      createElement.mockRestore()
    }
  })

  it('clears a single layer raster when a layerId is given', () => {
    const rasterCtx = stubCtx()
    const compositeCtx = stubCtx()
    const createElement = vi
      .spyOn(document, 'createElement')
      .mockImplementation(() => stubCanvas(rasterCtx))
    const page: Page = {
      id: 'clear-one',
      strokes: [],
      layers: [stubLayer('A'), stubLayer('B')],
      createdAt: 0,
    }

    clearLayerRasterCache(page.id)
    try {
      paintLayers(stubCanvas(compositeCtx), compositeCtx, page, stubInk(), 1)
      expect(rasterCtx.clearRect).toHaveBeenCalledTimes(2) // both layers rasterized

      clearLayerRasterCache(page.id, 'A')
      paintLayers(stubCanvas(compositeCtx), compositeCtx, page, stubInk(), 1)
      expect(rasterCtx.clearRect).toHaveBeenCalledTimes(3) // only A rebuilt
    } finally {
      clearLayerRasterCache(page.id)
      createElement.mockRestore()
    }
  })

  it('exposes the cached layer raster for thumbnails', () => {
    const rasterCtx = stubCtx()
    const createElement = vi
      .spyOn(document, 'createElement')
      .mockImplementation(() => stubCanvas(rasterCtx))
    const page: Page = {
      id: 'thumb-page',
      strokes: [],
      layers: [stubLayer('L')],
      createdAt: 0,
    }

    clearLayerRasterCache(page.id)
    try {
      const raster = layerRasterCanvas(page, stubInk(), 'L')
      expect(raster).not.toBeNull()
      expect(raster!.width).toBe(3072)
      // A second call hits the same raster.
      expect(layerRasterCanvas(page, stubInk(), 'L')).toBe(raster)
      expect(rasterCtx.clearRect).toHaveBeenCalledTimes(1)
    } finally {
      clearLayerRasterCache(page.id)
      createElement.mockRestore()
    }
  })
})

describe('layer compositing', () => {
  const mockCanvases = (gco: string[], blends: string[]) => {
    const compositeCtx = stubCtx({ gco, blends })
    const createElement = vi
      .spyOn(document, 'createElement')
      .mockImplementation(() => stubCanvas(stubCtx({ gco, blends })))
    return { compositeCtx, createElement }
  }

  it('clips composited layers to the page rect', () => {
    const { compositeCtx, createElement } = mockCanvases([], [])
    const page: Page = {
      id: 'page-clip-bounds',
      strokes: [],
      layers: [stubLayer('L', { x: 400, rotation: 45 })],
      createdAt: 0,
    }

    clearLayerRasterCache(page.id)
    try {
      paintLayers(stubCanvas(compositeCtx), compositeCtx, page, stubInk(), 1)
      // A transformed layer's raster would spill past the paper edge — the
      // composite clips to the page rect (in page units under the display
      // transform) so nothing paints on the backdrop.
      expect(compositeCtx.beginPath).toHaveBeenCalled()
      expect(compositeCtx.rect).toHaveBeenCalledWith(0, 0, PAGE_W, PAGE_H)
      expect(compositeCtx.clip).toHaveBeenCalled()
    } finally {
      clearLayerRasterCache(page.id)
      createElement.mockRestore()
    }
  })

  it('composites a layer with its blend mode', () => {
    const gco: string[] = []
    const blends: string[] = []
    const { compositeCtx, createElement } = mockCanvases(gco, blends)
    const page: Page = {
      id: 'blend-page',
      strokes: [],
      layers: [stubLayer('L', { blend: 'multiply' })],
      createdAt: 0,
    }

    clearLayerRasterCache(page.id)
    try {
      paintLayers(stubCanvas(compositeCtx), compositeCtx, page, stubInk(), 1)
      expect(blends).toContain('multiply')
    } finally {
      clearLayerRasterCache(page.id)
      createElement.mockRestore()
    }
  })

  it('paints alpha-locked strokes with source-atop, others normally', () => {
    const gco: string[] = []
    const { compositeCtx, createElement } = mockCanvases(gco, [])
    const page: Page = {
      id: 'lock-page',
      strokes: [
        { tool: 'write', color: '#111111', pts: [{ x: 0, y: 0, t: 0, p: 0.5 }], layerId: 'L' },
        {
          tool: 'write',
          color: '#222222',
          pts: [{ x: 0, y: 0, t: 0, p: 0.5 }],
          layerId: 'L',
          alphaLock: true,
        },
      ],
      layers: [stubLayer('L')],
      createdAt: 0,
    }

    clearLayerRasterCache(page.id)
    try {
      paintLayers(stubCanvas(compositeCtx), compositeCtx, page, stubInk(), 1)
      expect(gco.filter((v) => v === 'source-atop')).toHaveLength(1)
    } finally {
      clearLayerRasterCache(page.id)
      createElement.mockRestore()
    }
  })

  it('masks a clipped layer to the layer below via destination-in', () => {
    const gco: string[] = []
    const { compositeCtx, createElement } = mockCanvases(gco, [])
    const page: Page = {
      id: 'clip-page',
      strokes: [],
      layers: [stubLayer('base'), stubLayer('top', { clip: true })],
      createdAt: 0,
    }

    clearLayerRasterCache(page.id)
    try {
      paintLayers(stubCanvas(compositeCtx), compositeCtx, page, stubInk(), 1)
      expect(gco).toContain('destination-in')
    } finally {
      clearLayerRasterCache(page.id)
      createElement.mockRestore()
    }
  })

  it('draws a clipped layer normally when no visible base exists', () => {
    const gco: string[] = []
    const { compositeCtx, createElement } = mockCanvases(gco, [])
    const page: Page = {
      id: 'clip-no-base',
      strokes: [],
      layers: [stubLayer('hidden', { visible: false }), stubLayer('top', { clip: true })],
      createdAt: 0,
    }

    clearLayerRasterCache(page.id)
    try {
      paintLayers(stubCanvas(compositeCtx), compositeCtx, page, stubInk(), 1)
      expect(gco).not.toContain('destination-in')
      expect(compositeCtx.drawImage).toHaveBeenCalled()
    } finally {
      clearLayerRasterCache(page.id)
      createElement.mockRestore()
    }
  })
})
