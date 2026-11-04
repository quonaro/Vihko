import { getPhoto } from '../ink/ops'

// Rasterize a journal cover into a canvas texture: cover color or photo.
// The title is not part of the texture — the shelf shows it as a DOM label
// under each book.

export const COVER_W = 384
export const COVER_H = Math.round(COVER_W / 0.735) // matches shelfLayout aspect

export interface CoverInput {
  color: string // resolved cover color (hex)
  coverImg?: string | null // dataURL photo cover — wins over `color`
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

  // Sheen like the DOM ::before gradient: gloss top-left, shade bottom-right.
  const g = ctx.createLinearGradient(0, 0, w, h)
  g.addColorStop(0, 'rgba(255,255,255,0.2)')
  g.addColorStop(0.39, 'rgba(255,255,255,0.04)')
  g.addColorStop(0.58, 'rgba(255,255,255,0)')
  g.addColorStop(1, 'rgba(0,0,0,0.18)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
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
