import { describe, it, expect, vi } from 'vitest'
import { applyCut, floodFill } from './ops'

// floodFill only needs ctx.getImageData/putImageData, so a plain pixel buffer
// stands in for the canvas 2d backend that jsdom lacks.
const PAPER = [246, 241, 230] as const

interface Put {
  x: number
  y: number
  w: number
  h: number
}

function fakeCtx(w: number, h: number) {
  const img = { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = PAPER[0]
    img.data[i + 1] = PAPER[1]
    img.data[i + 2] = PAPER[2]
    img.data[i + 3] = 255
  }
  const puts: Put[] = []
  const ctx = {
    getImageData: () => img as ImageData,
    putImageData: (
      _img: ImageData,
      _dx: number,
      _dy: number,
      x = 0,
      y = 0,
      dw = 0,
      dh = 0,
    ) => puts.push({ x, y, w: dw, h: dh }),
  } as unknown as CanvasRenderingContext2D
  return { ctx, img, puts }
}

const px = (img: { data: Uint8ClampedArray; width: number }, x: number, y: number) => {
  const i = (y * img.width + x) * 4
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]]
}

function setPx(
  img: { data: Uint8ClampedArray; width: number },
  x: number,
  y: number,
  rgba: [number, number, number, number],
) {
  const i = (y * img.width + x) * 4
  img.data[i] = rgba[0]
  img.data[i + 1] = rgba[1]
  img.data[i + 2] = rgba[2]
  img.data[i + 3] = rgba[3]
}

describe('floodFill', () => {
  it('fills an enclosed region and writes back only its bbox', () => {
    const { ctx, img, puts } = fakeCtx(40, 40)
    // black border rect (10,10)-(30,30)
    for (let i = 10; i <= 30; i++) {
      setPx(img, i, 10, [30, 30, 30, 255])
      setPx(img, i, 30, [30, 30, 30, 255])
      setPx(img, 10, i, [30, 30, 30, 255])
      setPx(img, 30, i, [30, 30, 30, 255])
    }
    floodFill(ctx, 40, 40, 20, 20, '#ff0000')

    expect(px(img, 20, 20)).toEqual([255, 0, 0, 255])
    expect(px(img, 11, 29)).toEqual([255, 0, 0, 255])
    // outside the border stays paper
    expect(px(img, 5, 5)).toEqual([246, 241, 230, 255])
    // the border itself is untouched
    expect(px(img, 10, 10)).toEqual([30, 30, 30, 255])
    // writeback is clipped to the painted bbox: pixels (11..29) x (11..29)
    expect(puts).toHaveLength(1)
    expect(puts[0]).toEqual({ x: 11, y: 11, w: 19, h: 19 })
  })

  it('treats erased (alpha < 128) pixels as paper and fills through them', () => {
    const { ctx, img } = fakeCtx(20, 20)
    // a vertical erased stripe that should not block the fill
    for (let y = 0; y < 20; y++) setPx(img, 10, y, [0, 0, 0, 0])
    floodFill(ctx, 20, 20, 2, 10, '#00ff00')
    expect(px(img, 2, 10)).toEqual([0, 255, 0, 255])
    expect(px(img, 15, 10)).toEqual([0, 255, 0, 255])
    expect(px(img, 10, 10)).toEqual([0, 255, 0, 255]) // erased px gets painted too
  })

  it('does nothing when the seed already has the target color', () => {
    const { ctx, img, puts } = fakeCtx(10, 10)
    setPx(img, 5, 5, [255, 0, 0, 255])
    floodFill(ctx, 10, 10, 5, 5, '#ff0000')
    expect(puts).toHaveLength(0)
  })

  it('ignores seeds outside the canvas', () => {
    const { ctx, puts } = fakeCtx(10, 10)
    floodFill(ctx, 10, 10, -5, 5, '#ff0000')
    floodFill(ctx, 10, 10, 5, 99, '#ff0000')
    expect(puts).toHaveLength(0)
  })
})

describe('applyCut', () => {
  it('clears lifted pixels to transparency so lower layers remain visible', () => {
    const makeContext = () => ({
      save: vi.fn(),
      restore: vi.fn(),
      setTransform: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      closePath: vi.fn(),
      clip: vi.fn(),
      drawImage: vi.fn(),
      clearRect: vi.fn(),
      fillRect: vi.fn(),
    }) as unknown as CanvasRenderingContext2D
    const pieceContext = makeContext()
    const piece = {
      width: 100,
      height: 80,
      getContext: () => pieceContext,
    } as unknown as HTMLCanvasElement
    const createElement = vi.spyOn(document, 'createElement').mockReturnValue(piece)
    const ctx = makeContext()
    const canvas = { width: 100, height: 80 } as HTMLCanvasElement

    applyCut(canvas, ctx, {
      kind: 'cut',
      path: [{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 20, y: 30 }],
      dx: 5,
      dy: 0,
      after: 0,
      layerId: '*',
    }, 1, 0, 0)

    expect((ctx as unknown as { clearRect: ReturnType<typeof vi.fn> }).clearRect).toHaveBeenCalledWith(0, 0, 100, 80)
    expect((ctx as unknown as { fillRect: ReturnType<typeof vi.fn> }).fillRect).not.toHaveBeenCalled()
    createElement.mockRestore()
  })
})
