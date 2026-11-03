import { describe, expect, it, vi } from 'vitest'
import { PAGE_H, PAGE_W } from '../pageSpace'
import type { InkEngine, Layer, Page } from '../types'
import { clearLayerRasterCache, cutOpForLayer, paintLayers } from './layers'

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
      clearRect: vi.fn(),
    } as unknown as CanvasRenderingContext2D

    paintLayers({ width: 100, height: 100 } as HTMLCanvasElement, ctx, page, {} as InkEngine, 1)

    expect(ctx.clearRect).toHaveBeenCalledTimes(1)
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
