import { logger } from '../log'
import type { InkEngine, PageOp, PhotoItem } from '../types'

const log = logger('ink:ops')

const PAPER = '#f6f1e6'

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const v =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)]
}

// The device-px rect confining an op's pixels — ops committed while a
// spread half was focused carry `op.rect` so their effect can't cross the
// fold. Clipped to the canvas; null when the rect misses it entirely, in
// which case the op paints nothing.
function opRegion(
  canvas: { width: number; height: number },
  op: { rect?: { x: number; y: number; w: number; h: number } },
  scale: number,
  ox: number,
  oy: number,
): { x: number; y: number; w: number; h: number } | null {
  if (!op.rect) return { x: 0, y: 0, w: canvas.width, h: canvas.height }
  const x0 = Math.max(0, Math.floor(op.rect.x * scale + ox))
  const y0 = Math.max(0, Math.floor(op.rect.y * scale + oy))
  const x1 = Math.min(canvas.width, Math.ceil((op.rect.x + op.rect.w) * scale + ox))
  const y1 = Math.min(canvas.height, Math.ceil((op.rect.y + op.rect.h) * scale + oy))
  if (x1 <= x0 || y1 <= y0) return null
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

// --- flood fill -----------------------------------------------------------
// Scanline BFS from the seed point. Pixels with alpha < 128 (erased) are
// treated as paper color so eraser marks don't break the fill region.
// `rect` (device px) confines the flood to a sub-region — the pixel buffer
// and all kernel/fallback logic run on that crop, so the fill can't leak
// past a spread fold.
export function floodFill(
  ctx: CanvasRenderingContext2D,
  wDev: number,
  hDev: number,
  sx: number,
  sy: number,
  color: string,
  tol = 42,
  ink?: InkEngine | null,
  invert = false,
  rect?: { x: number; y: number; w: number; h: number },
) {
  const ix = Math.round(sx)
  const iy = Math.round(sy)
  let bx = 0
  let by = 0
  let bw = wDev
  let bh = hDev
  if (rect) {
    const x0 = Math.max(0, Math.floor(rect.x))
    const y0 = Math.max(0, Math.floor(rect.y))
    const x1 = Math.min(wDev, Math.ceil(rect.x + rect.w))
    const y1 = Math.min(hDev, Math.ceil(rect.y + rect.h))
    if (x1 <= x0 || y1 <= y0) {
      log.debug('fill skipped: op rect misses the canvas')
      return
    }
    bx = x0
    by = y0
    bw = x1 - x0
    bh = y1 - y0
  }
  if (ix < bx || iy < by || ix >= bx + bw || iy >= by + bh) {
    log.debug('fill skipped: seed outside the region', { ix, iy })
    return
  }
  if (typeof ctx.getImageData !== 'function') return // no 2d backend (jsdom)

  const img = ctx.getImageData(bx, by, bw, bh)
  const d = img.data
  const [pr, pg, pb] = hexToRgb(PAPER)
  const [tr, tg, tb] = hexToRgb(color)
  const six = ix - bx
  const siy = iy - by

  // Inverse fill: paint everything outside the seed's matching region.
  if (invert && ink?.inverseFill) {
    const n = ink.inverseFill(d, bw, bh, six, siy, tr, tg, tb, tol, pr, pg, pb, 128)
    if (n > 0) ctx.putImageData(img, bx, by)
    log.debug('inverse fill via engine kernel', n)
    return
  }
  if (invert) {
    log.debug('inverse fill skipped: no engine kernel')
    return
  }

  // WASM/engine kernel when present — the per-pixel loop runs natively.
  if (ink?.floodFill) {
    const n = ink.floodFill(d, bw, bh, six, siy, tr, tg, tb, tol, pr, pg, pb, 128)
    if (n > 0) ctx.putImageData(img, bx, by)
    log.debug('fill via engine kernel', n)
    return
  }
  log.debug('fill via JS scanline fallback')
  const si = (siy * bw + six) * 4
  const sr = d[si + 3] < 128 ? pr : d[si]
  const sg = d[si + 3] < 128 ? pg : d[si + 1]
  const sb = d[si + 3] < 128 ? pb : d[si + 2]

  // no-op if the seed pixel is already the target color
  if (Math.abs(sr - tr) + Math.abs(sg - tg) + Math.abs(sb - tb) < 3) {
    log.debug('fill skipped: seed already has the target color')
    return
  }

  const tol3 = tol * 3
  // Erased pixels read as paper, so their match result is a constant.
  const erasedMatches = Math.abs(pr - sr) + Math.abs(pg - sg) + Math.abs(pb - sb) <= tol3
  const matches = (i: number) =>
    d[i + 3] < 128
      ? erasedMatches
      : Math.abs(d[i] - sr) + Math.abs(d[i + 1] - sg) + Math.abs(d[i + 2] - sb) <= tol3

  const visited = new Uint8Array(bw * bh)
  const stack: number[] = [siy * bw + six]
  // Track the painted bbox so putImageData only writes back what changed.
  let x0 = bw
  let y0 = bh
  let x1 = -1
  let y1 = -1
  while (stack.length) {
    const p = stack.pop()!
    if (visited[p] || !matches(p * 4)) continue
    const y = (p / bw) | 0
    const x = p % bw
    // walk left/right along the scanline
    let l = x
    let r = x
    while (l > 0 && !visited[p - (x - l) - 1] && matches((p - (x - l) - 1) * 4)) l--
    while (r < bw - 1 && !visited[p + (r - x) + 1] && matches((p + (r - x) + 1) * 4)) r++
    for (let i = l; i <= r; i++) {
      const idx = y * bw + i
      visited[idx] = 1
      const o = idx * 4
      d[o] = tr
      d[o + 1] = tg
      d[o + 2] = tb
      d[o + 3] = 255
    }
    if (l < x0) x0 = l
    if (r > x1) x1 = r
    if (y < y0) y0 = y
    if (y > y1) y1 = y
    // Queue one seed per contiguous matching span on adjacent scanlines.
    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= bh) continue
      let xs = l
      while (xs <= r) {
        const idx = ny * bw + xs
        if (!visited[idx] && matches(idx * 4)) {
          stack.push(idx)
          xs++
          while (xs <= r && !visited[ny * bw + xs] && matches((ny * bw + xs) * 4)) xs++
        } else {
          xs++
        }
      }
    }
  }
  if (x1 >= 0) ctx.putImageData(img, bx, by, x0, y0, x1 - x0 + 1, y1 - y0 + 1)
}

// --- cut ------------------------------------------------------------------
// scale/ox/oy map page units to device px: dev = page * scale + offset.
export function pathTo(
  ctx: CanvasRenderingContext2D,
  pts: { x: number; y: number }[],
  scale: number,
  ox: number,
  oy: number,
) {
  ctx.beginPath()
  ctx.moveTo(pts[0].x * scale + ox, pts[0].y * scale + oy)
  for (const p of pts.slice(1)) ctx.lineTo(p.x * scale + ox, p.y * scale + oy)
  ctx.closePath()
}

// Lift the pixels inside `path` off the canvas; returns the captured piece
// (device px) and clears the region to `clearColor`.
export function extractRegion(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  path: { x: number; y: number }[],
  scale: number,
  ox: number,
  oy: number,
  clearColor: string | null = PAPER,
): HTMLCanvasElement | null {
  if (path.length < 3) {
    log.debug('extractRegion skipped: degenerate path', path.length)
    return null
  }
  const piece = document.createElement('canvas')
  piece.width = canvas.width
  piece.height = canvas.height
  const pc = piece.getContext('2d')!
  pc.save()
  pathTo(pc, path, scale, ox, oy)
  pc.clip()
  pc.drawImage(canvas, 0, 0)
  pc.restore()

  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  pathTo(ctx, path, scale, ox, oy)
  ctx.clip()
  if (clearColor) {
    ctx.fillStyle = clearColor
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  } else {
    ctx.clearRect(0, 0, canvas.width, canvas.height)
  }
  ctx.restore()
  return piece
}

export function applyCut(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  op: Extract<PageOp, { kind: 'cut' }>,
  scale: number,
  ox: number,
  oy: number,
) {
  // Layer rasters are transparent; clearing to paper here would hide content
  // on lower layers after a cut.
  const piece = extractRegion(canvas, ctx, op.path, scale, ox, oy, null)
  if (piece) ctx.drawImage(piece, op.dx * scale, op.dy * scale)
}

// --- photos ---------------------------------------------------------------
const imageCache = new Map<string, HTMLImageElement>()
const loadListeners = new Set<() => void>()

export function onImageLoaded(fn: () => void) {
  loadListeners.add(fn)
  return () => loadListeners.delete(fn)
}

export function getPhoto(src: string): HTMLImageElement | null {
  let img = imageCache.get(src)
  if (!img) {
    log.debug('photo cache miss, decoding', src.slice(0, 32))
    img = new Image()
    img.onload = () =>
      loadListeners.forEach((f) => {
        f()
      })
    img.onerror = () => log.warn('photo failed to decode', src.slice(0, 32))
    img.src = src
    imageCache.set(src, img)
  }
  return img.complete && img.naturalWidth ? img : null
}

export function applyPhoto(
  ctx: CanvasRenderingContext2D,
  photo: PhotoItem,
  scale: number,
  ox: number,
  oy: number,
) {
  const img = getPhoto(photo.src)
  if (!img) return
  ctx.save()
  ctx.setTransform(scale, 0, 0, scale, ox, oy)
  ctx.drawImage(img, photo.x, photo.y, photo.w, photo.h)
  ctx.restore()
}

// --- replay a single non-stroke op onto the canvas -------------------------
// scale/ox/oy map page units to device px (dev = page * scale + offset).
export function applyOp(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  op: PageOp,
  scale: number,
  ox = 0,
  oy = 0,
  ink?: InkEngine | null,
) {
  log.debug('applyOp', op.kind)
  switch (op.kind) {
    case 'fill': {
      const region = opRegion(canvas, op, scale, ox, oy)
      if (!region) break
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      floodFill(
        ctx,
        canvas.width,
        canvas.height,
        op.x * scale + ox,
        op.y * scale + oy,
        op.color,
        42,
        ink,
        op.invert,
        region,
      )
      ctx.restore()
      break
    }
    case 'erase': {
      if (!ink?.eraseColor || typeof ctx.getImageData !== 'function') break
      const region = opRegion(canvas, op, scale, ox, oy)
      if (!region) break
      const img = ctx.getImageData(region.x, region.y, region.w, region.h)
      if (!img?.data) break
      const n = ink.eraseColor(
        img.data,
        region.w,
        region.h,
        Math.round(op.x * scale + ox) - region.x,
        Math.round(op.y * scale + oy) - region.y,
        48,
      )
      if (n > 0) ctx.putImageData(img, region.x, region.y)
      break
    }
    case 'filter': {
      if (!ink || typeof ctx.getImageData !== 'function') break
      const region = opRegion(canvas, op, scale, ox, oy)
      if (!region) break
      const img = ctx.getImageData(region.x, region.y, region.w, region.h)
      if (!img?.data) break
      const d = img.data
      if (op.filter === 'blur' && ink.boxBlur) {
        ink.boxBlur(d, region.w, region.h, Math.max(1, Math.round(op.amount ?? 4)))
      } else if (op.filter === 'sharpen' && ink.sharpen) {
        ink.sharpen(d, region.w, region.h, op.amount ?? 1)
      } else if (op.filter === 'adjust' && ink.adjust) {
        ink.adjust(d, op.brightness ?? 0, op.contrast ?? 0, op.saturation ?? 0)
      } else {
        break
      }
      ctx.putImageData(img, region.x, region.y)
      break
    }
    case 'cut':
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      applyCut(canvas, ctx, op, scale, ox, oy)
      ctx.restore()
      break
    case 'photo':
      applyPhoto(ctx, op.photo, scale, ox, oy)
      break
    case 'clear': {
      const region = opRegion(canvas, op, scale, ox, oy)
      if (!region) break
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(region.x, region.y, region.w, region.h)
      ctx.restore()
      break
    }
  }
}

// Downscale an imported image for storage. Two-stage halving keeps detail the
// single-shot canvas downscale loses; images with alpha stay PNG so
// transparency survives (JPEG would flatten it onto black).
export function imageFileToPhoto(
  file: File,
  maxDim = 2048,
): Promise<{ src: string; w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const k = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight))
      const w = Math.max(1, Math.round(img.naturalWidth * k))
      const h = Math.max(1, Math.round(img.naturalHeight * k))
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      const c2 = c.getContext('2d', { willReadFrequently: true })!
      // Progressive halving: draw at <=2x the target first, then at target.
      let src: CanvasImageSource = img
      let sw = img.naturalWidth
      let sh = img.naturalHeight
      while (sw / 2 > w && sh / 2 > h) {
        const t = document.createElement('canvas')
        t.width = Math.max(1, sw >> 1)
        t.height = Math.max(1, sh >> 1)
        t.getContext('2d')!.drawImage(src, 0, 0, t.width, t.height)
        src = t
        sw = t.width
        sh = t.height
      }
      c2.drawImage(src, 0, 0, w, h)
      URL.revokeObjectURL(img.src)
      const { data } = c2.getImageData(0, 0, w, h)
      let hasAlpha = false
      for (let i = 3; i < data.length; i += 16) {
        if (data[i] < 250) {
          hasAlpha = true
          break
        }
      }
      log.debug('photo imported', { w, h, hasAlpha })
      resolve({ src: imageDataURL(c, hasAlpha), w, h })
    }
    img.onerror = (e) => {
      log.warn('photo file failed to decode', e)
      reject(e)
    }
    img.src = URL.createObjectURL(file)
  })
}

// Smallest sensible raster serialization: WebP when the engine supports it
// (lossy + alpha-capable), PNG for alpha, JPEG otherwise. `toDataURL`
// silently falls back to PNG on unsupported types, so the header is checked.
export function imageDataURL(c: HTMLCanvasElement, hasAlpha: boolean, quality = 0.92): string {
  const webp = c.toDataURL('image/webp', quality)
  if (webp.startsWith('data:image/webp')) return webp
  const format = hasAlpha ? 'png' : 'jpeg'
  log.debug('webp unsupported, serializing as', format)
  return hasAlpha ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', quality)
}
