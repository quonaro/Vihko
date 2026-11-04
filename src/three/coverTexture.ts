import { getPhoto } from '../ink/ops'
import type { CoverTexture } from '../types'

// Rasterize a journal cover into a canvas texture: cover color or photo.
// The title is not part of the texture — the shelf shows it as a DOM label
// under each book.

export const COVER_W = 384
export const COVER_H = Math.round(COVER_W / 0.735) // matches shelfLayout aspect

const GRAIN_SIZE = 96
let grainTile: HTMLCanvasElement | null | undefined

export interface CoverInput {
  color: string // resolved cover color (hex)
  coverImg?: string | null // dataURL photo cover — wins over `color`
  coverTexture?: CoverTexture
}

function paperGrain(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  if (typeof ctx.createPattern !== 'function') return null
  if (grainTile === undefined) {
    const tile = document.createElement('canvas')
    tile.width = tile.height = GRAIN_SIZE
    const tileCtx = tile.getContext('2d')
    if (!tileCtx) {
      grainTile = null
    } else {
      const image = tileCtx.createImageData(GRAIN_SIZE, GRAIN_SIZE)
      let seed = 0x51f15e
      const random = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0
        return seed
      }
      for (let y = 0; y < GRAIN_SIZE; y += 2) {
        for (let x = 0; x < GRAIN_SIZE; x += 2) {
          const light = random() & 1
          const alpha = 10 + (random() % 13)
          for (let dy = 0; dy < 2; dy++) {
            for (let dx = 0; dx < 2; dx++) {
              const i = ((y + dy) * GRAIN_SIZE + x + dx) * 4
              image.data[i] = image.data[i + 1] = image.data[i + 2] = light ? 255 : 0
              image.data[i + 3] = alpha
            }
          }
        }
      }
      tileCtx.putImageData(image, 0, 0)
      grainTile = tile
    }
  }
  return grainTile ? ctx.createPattern(grainTile, 'repeat') : null
}

function comicHalftone(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.fillStyle = 'rgba(30,24,21,0.6)'
  for (let y = Math.round(h * 0.58); y < h; y += 13) {
    for (let x = 10; x < w; x += 13) {
      ctx.globalAlpha = 0.16 + 0.16 * ((y - h * 0.58) / (h * 0.42))
      ctx.beginPath()
      ctx.arc(x, y, 1.8, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  ctx.globalAlpha = 1
}

export function dominantColorFromPixels(data: Uint8ClampedArray): string {
  const bins = new Map<number, { count: number; r: number; g: number; b: number }>()
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3] < 128) continue
    const r = data[i],
      g = data[i + 1],
      b = data[i + 2]
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
    const bin = bins.get(key) ?? { count: 0, r: 0, g: 0, b: 0 }
    bin.count++
    bin.r += r
    bin.g += g
    bin.b += b
    bins.set(key, bin)
  }
  const dominant = [...bins.values()].sort((a, b) => b.count - a.count)[0]
  if (!dominant) return '#000000'
  return `#${[dominant.r, dominant.g, dominant.b]
    .map((sum) =>
      Math.round(sum / dominant.count)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`
}

export function dominantCoverColor(input: CoverInput): string {
  const img = input.coverImg ? getPhoto(input.coverImg) : null
  if (!img?.naturalWidth || !img.naturalHeight) return input.color
  const size = 32
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return input.color
  const scale = Math.max(size / img.naturalWidth, size / img.naturalHeight)
  const w = img.naturalWidth * scale
  const h = img.naturalHeight * scale
  try {
    ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h)
    return dominantColorFromPixels(ctx.getImageData(0, 0, size, size).data)
  } catch {
    return input.color
  }
}

export function paintCover(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  input: CoverInput,
) {
  const w = canvas.width
  const h = canvas.height
  const img = input.coverImg ? getPhoto(input.coverImg) : null
  ctx.clearRect(0, 0, w, h)
  if (img) {
    const s = Math.max(w / img.naturalWidth, h / img.naturalHeight)
    const iw = img.naturalWidth * s
    const ih = img.naturalHeight * s
    ctx.drawImage(img, (w - iw) / 2, (h - ih) / 2, iw, ih)
  } else {
    ctx.fillStyle = input.color
    ctx.fillRect(0, 0, w, h)
  }

  const texture = input.coverTexture ?? 'paper'
  if (texture === 'comic') comicHalftone(ctx, w, h)
  else if (texture !== 'smooth') {
    // Fine, low-contrast grain gives paper a printed finish without gloss.
    const grain = paperGrain(ctx)
    if (grain) {
      ctx.fillStyle = grain
      ctx.fillRect(0, 0, w, h)
    }
  }
}

// Offscreen canvas snapshot of a cover; null when 2D is unavailable (jsdom).
export function coverCanvas(input: CoverInput, width = COVER_W): HTMLCanvasElement | null {
  const c = document.createElement('canvas')
  c.width = width
  c.height = Math.round(width / 0.735)
  const ctx = c.getContext('2d')
  if (!ctx) return null
  paintCover(c, ctx, input)
  return c
}
