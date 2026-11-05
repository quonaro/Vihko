import { describe, it, expect, vi } from 'vitest'
import { applyCut, applyOp, floodFill, imageDataURL } from './ops'

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
    putImageData: (_img: ImageData, _dx: number, _dy: number, x = 0, y = 0, dw = 0, dh = 0) =>
      puts.push({ x, y, w: dw, h: dh }),
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

// A pixel-buffer ctx honoring getImageData/putImageData sub-rects — lets
// op tests assert exactly which pixels an op touched.
function bufferCtx(w: number, h: number) {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = PAPER[0]
    data[i + 1] = PAPER[1]
    data[i + 2] = PAPER[2]
    data[i + 3] = 255
  }
  const ctx = {
    save: () => {},
    restore: () => {},
    setTransform: () => {},
    clearRect: (x: number, y: number, cw: number, ch: number) => {
      for (let r = y; r < y + ch; r++)
        for (let c = x; c < x + cw; c++) {
          const i = (r * w + c) * 4
          for (let k = 0; k < 4; k++) data[i + k] = 0
        }
    },
    getImageData: (x = 0, y = 0, sw = w, sh = h) => {
      const sub = new Uint8ClampedArray(sw * sh * 4)
      for (let r = 0; r < sh; r++)
        for (let c = 0; c < sw; c++) {
          const si = ((y + r) * w + x + c) * 4
          const di = (r * sw + c) * 4
          for (let k = 0; k < 4; k++) sub[di + k] = data[si + k]
        }
      return { data: sub, width: sw, height: sh } as ImageData
    },
    putImageData: (img: ImageData, dx = 0, dy = 0) => {
      for (let r = 0; r < img.height; r++)
        for (let c = 0; c < img.width; c++) {
          const si = (r * img.width + c) * 4
          const di = ((dy + r) * w + dx + c) * 4
          for (let k = 0; k < 4; k++) data[di + k] = img.data[si + k]
        }
    },
  } as unknown as CanvasRenderingContext2D
  const pxAt = (x: number, y: number) => {
    const i = (y * w + x) * 4
    return [data[i], data[i + 1], data[i + 2], data[i + 3]]
  }
  return { ctx, pxAt }
}

describe('spread-region ops', () => {
  const canvas = { width: 40, height: 20 } as HTMLCanvasElement
  const LEFT = { x: 0, y: 0, w: 20, h: 20 }

  it('a confined fill floods only its half — the fold is a hard edge', () => {
    const { ctx, pxAt } = bufferCtx(40, 20)
    applyOp(
      canvas,
      ctx,
      { kind: 'fill', x: 5, y: 10, color: '#ff0000', after: 0, rect: LEFT },
      1,
      0,
      0,
    )
    expect(pxAt(5, 10)).toEqual([255, 0, 0, 255])
    expect(pxAt(19, 10)).toEqual([255, 0, 0, 255])
    expect(pxAt(20, 10)).toEqual([246, 241, 230, 255])
    expect(pxAt(35, 10)).toEqual([246, 241, 230, 255])
  })

  it('an unconfined fill still floods the whole canvas', () => {
    const { ctx, pxAt } = bufferCtx(40, 20)
    applyOp(canvas, ctx, { kind: 'fill', x: 5, y: 10, color: '#ff0000', after: 0 }, 1, 0, 0)
    expect(pxAt(35, 10)).toEqual([255, 0, 0, 255])
  })

  it('a confined fill does nothing when the seed is outside the rect', () => {
    const { ctx, pxAt } = bufferCtx(40, 20)
    applyOp(
      canvas,
      ctx,
      { kind: 'fill', x: 30, y: 10, color: '#ff0000', after: 0, rect: LEFT },
      1,
      0,
      0,
    )
    expect(pxAt(5, 10)).toEqual([246, 241, 230, 255])
  })

  it('a confined clear wipes only inside the rect', () => {
    const { ctx, pxAt } = bufferCtx(40, 20)
    applyOp(canvas, ctx, { kind: 'clear', after: 0, rect: LEFT }, 1, 0, 0)
    expect(pxAt(5, 10)).toEqual([0, 0, 0, 0])
    expect(pxAt(35, 10)).toEqual([246, 241, 230, 255])
  })
})

describe('applyCut', () => {
  it('clears lifted pixels to transparency so lower layers remain visible', () => {
    const makeContext = () =>
      ({
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

    applyCut(
      canvas,
      ctx,
      {
        kind: 'cut',
        path: [
          { x: 10, y: 10 },
          { x: 30, y: 10 },
          { x: 20, y: 30 },
        ],
        dx: 5,
        dy: 0,
        after: 0,
        layerId: '*',
      },
      1,
      0,
      0,
    )

    expect(
      (ctx as unknown as { clearRect: ReturnType<typeof vi.fn> }).clearRect,
    ).toHaveBeenCalledWith(0, 0, 100, 80)
    expect(
      (ctx as unknown as { fillRect: ReturnType<typeof vi.fn> }).fillRect,
    ).not.toHaveBeenCalled()
    createElement.mockRestore()
  })
})

describe('imageDataURL', () => {
  it('prefers webp and falls back by alpha', () => {
    const calls: string[] = []
    const c = {
      toDataURL(type: string) {
        calls.push(type)
        return type === 'image/webp' ? 'data:image/webp;base64,x' : 'data:other'
      },
    } as unknown as HTMLCanvasElement
    expect(imageDataURL(c, true)).toBe('data:image/webp;base64,x')
    expect(calls).toHaveLength(1)
  })
})
