import { getPhoto } from '../ink/ops'

// Rasterize a journal cover into a canvas texture: cover color or photo,
// the darker spine strip and the centered title — the same marks the DOM
// covers draw with .spine/.title.

export const COVER_W = 384
export const COVER_H = Math.round(COVER_W / 0.735) // matches shelfLayout aspect

export interface CoverInput {
  title: string
  color: string // resolved cover color (hex)
  coverImg?: string | null // dataURL photo cover — wins over `color`
}

export function dominantColorFromPixels(data: Uint8ClampedArray): string {
  const bins = new Map<number, { count: number; r: number; g: number; b: number }>()
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3] < 128) continue
    const r = data[i], g = data[i + 1], b = data[i + 2]
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
    .map((sum) => Math.round(sum / dominant.count).toString(16).padStart(2, '0'))
    .join('')}`
}

export function dominantCoverColor(input: CoverInput): string {
  const img = input.coverImg ? getPhoto(input.coverImg) : null
  if (!img || !img.naturalWidth || !img.naturalHeight) return input.color
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

// Greedy word-wrap for the cover title; `measure` reports px width so the
// function stays testable without a real canvas context.
export function fitLines(
  title: string,
  measure: (s: string) => number,
  maxW: number,
  maxLines = 3,
): string[] {
  const words = title.split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const lines: string[] = []
  let cur = words[0]
  for (const w of words.slice(1)) {
    const next = `${cur} ${w}`
    if (measure(next) <= maxW) cur = next
    else {
      lines.push(cur)
      cur = w
    }
  }
  lines.push(cur)
  if (lines.length > maxLines) {
    lines.length = maxLines
    let last = lines[maxLines - 1]
    while (last.length > 1 && measure(`${last}…`) > maxW) last = last.slice(0, -1)
    lines[maxLines - 1] = `${last.trimEnd()}…`
  }
  return lines
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

  // A restrained printed halftone makes the hard-shaded 3D covers feel inked.
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

  ctx.fillStyle = 'rgba(0,0,0,0.22)'
  ctx.fillRect(0, 0, w * 0.075, h)

  ctx.fillStyle = 'rgba(255,255,255,0.9)'
  ctx.font = `700 ${Math.round(w * 0.078)}px system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.shadowColor = 'rgba(0,0,0,0.65)'
  ctx.shadowBlur = 6
  ctx.shadowOffsetY = 2
  const lines = fitLines(input.title, (s) => ctx.measureText(s).width, w * 0.72)
  const lh = w * 0.105
  const y0 = h / 2 - ((lines.length - 1) * lh) / 2
  lines.forEach((ln, i) => ctx.fillText(ln, w / 2, y0 + i * lh))
  ctx.shadowColor = 'transparent'
  ctx.shadowBlur = 0
  ctx.shadowOffsetY = 0

  ctx.strokeStyle = 'rgba(35,28,24,0.58)'
  ctx.lineWidth = Math.max(2, w * 0.008)
  ctx.strokeRect(ctx.lineWidth, ctx.lineWidth, w - ctx.lineWidth * 2, h - ctx.lineWidth * 2)
}

// Offscreen canvas snapshot of a cover; null when 2D is unavailable (jsdom).
export function coverCanvas(
  input: CoverInput,
  width = COVER_W,
): HTMLCanvasElement | null {
  const c = document.createElement('canvas')
  c.width = width
  c.height = Math.round(width / 0.735)
  const ctx = c.getContext('2d')
  if (!ctx) return null
  paintCover(c, ctx, input)
  return c
}
