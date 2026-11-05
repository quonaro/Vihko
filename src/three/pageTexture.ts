import type { InkEngine, Page } from '../types'
import { paintLayers } from '../ink/layers'
import { logger } from '../log'
import { PAGE_ASPECT, PAGE_UNIT, pageSize } from '../pageSpace'
import { GL_QUALITY_KEY, readQuality, type Quality } from '../quality'
import { pageRev } from '../store'

const log = logger('pageTex')

// Stroke points live in page units (~1071 wide reference): the DOM previews
// fit them into a 300px viewBox with a 0.28 factor. Same scale is reused here
// so a texture pixel maps 1:1 to a preview pixel at width 300.
export { PAGE_ASPECT, PAGE_UNIT }

const PAPER_TOP = '#fffefa'
const PAPER_BOT = '#f8f6f0'

// Canonical shading for a stack sheet: centre fold + edge shade. A sheet's
// resting surface and its turning representation should both request this
// variant (via `pageCanvas`/`repaintInto`'s fold+edgeShade params or the
// scene's texture cache key) so the handoff between resting geometry and
// moving leaf is pixel-identical — differing variants read as a texture
// swap at turn start/end. Additive helper; the boolean params are
// unchanged for any caller that still wants a distinct variant.
export const SHEET_SHADE = { fold: true, edgeShade: true } as const

// Texture width per render-quality tier. A leaf face maps only half of
// the page texture (see leafTexU in layout.ts), so the effective
// resolution per visible half-sheet is texW/2 — the 1024 default already
// reads soft at dpr 2+, and stack/overview zooms upscale it further.
// 'ultra' trades ~24 MB per cached page texture for deep-zoom sharpness.
const PAGE_TEX_W: Record<Quality, number> = {
  low: 768,
  medium: 1024,
  high: 2048,
  ultra: 3072,
}
export function pageTexWidth(q: Quality = readQuality(GL_QUALITY_KEY, 'medium')): number {
  return PAGE_TEX_W[q]
}

// Content pass: strokes + raster ops interleaved by `after`, then the paper
// gradient underlaid via destination-over (eraser holes show paper, not
// alpha). Shading overlays live in paintOverlays so they can be recomposed
// on top of a cached content raster.
function paintContent(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  page: Page,
  ink: InkEngine,
  force = false,
) {
  const scale = canvas.width / pageSize(page).w
  paintLayers(canvas, ctx, page, ink, scale, 0, 0, force)

  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalCompositeOperation = 'destination-over'
  const g = ctx.createLinearGradient(0, 0, canvas.width * 0.35, canvas.height)
  g.addColorStop(0, PAPER_TOP)
  g.addColorStop(1, PAPER_BOT)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.restore()
}

// Overlay pass baked on top of content: a centre fold so each sheet reads as
// a two-page spread; for stacked sheets a soft inset shade along every edge
// plus a crisp rim at the cut. Overlapping near-white sheets need that hard
// edge line; gradients alone still read as one surface where two front pages
// nearly coincide.
export function paintOverlays(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  fold?: boolean,
  edgeShade?: boolean,
) {
  if (!fold && !edgeShade) return
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalCompositeOperation = 'source-over'
  if (fold) {
    const cx = canvas.width / 2
    const sw = canvas.width * 0.07
    const left = ctx.createLinearGradient(cx - sw, 0, cx, 0)
    left.addColorStop(0, 'rgba(44,40,31,0)')
    left.addColorStop(1, 'rgba(44,40,31,0.055)')
    ctx.fillStyle = left
    ctx.fillRect(cx - sw, 0, sw, canvas.height)
    const right = ctx.createLinearGradient(cx, 0, cx + sw, 0)
    right.addColorStop(0, 'rgba(44,40,31,0.035)')
    right.addColorStop(1, 'rgba(44,40,31,0)')
    ctx.fillStyle = right
    ctx.fillRect(cx, 0, sw, canvas.height)
  }
  if (edgeShade) {
    const { width: w, height: h } = canvas
    const d = w * 0.045
    const edge = (g: CanvasGradient) => {
      g.addColorStop(0, 'rgba(44,40,31,0.035)')
      g.addColorStop(1, 'rgba(44,40,31,0)')
      ctx.fillStyle = g
    }
    edge(ctx.createLinearGradient(0, 0, d, 0))
    ctx.fillRect(0, 0, d, h)
    edge(ctx.createLinearGradient(w, 0, w - d, 0))
    ctx.fillRect(w - d, 0, d, h)
    edge(ctx.createLinearGradient(0, 0, 0, d))
    ctx.fillRect(0, 0, w, d)
    edge(ctx.createLinearGradient(0, h, 0, h - d))
    ctx.fillRect(0, h - d, w, d)
    const rim = 1
    ctx.fillStyle = 'rgba(44,40,31,0.04)'
    ctx.fillRect(0, 0, rim, h)
    ctx.fillRect(w - rim, 0, rim, h)
    ctx.fillRect(0, 0, w, rim)
    ctx.fillRect(0, h - rim, w, rim)
  }
  ctx.restore()
}

// Rasterize a whole page (content + overlays). Kept as the low-level "paint
// everything into this ctx" entry point — journalScene's repaint path and
// tests use it directly.
export function paintPage(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  page: Page,
  ink: InkEngine,
  fold?: boolean,
  edgeShade?: boolean,
) {
  paintContent(canvas, ctx, page, ink)
  paintOverlays(canvas, ctx, fold, edgeShade)
}

// --- cached content rasters ------------------------------------------------

interface BaseEntry {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  rev: number
}

// Repainting a page means replaying every stroke through the ink engine —
// the dominant cost of opening a journal. Bases (content + paper, no
// shading) survive scene remounts and journal re-opens, keyed by page id +
// width and invalidated by the store's content revision. Spread shadows and
// fan edge-shading then cost a drawImage + a few gradients per variant.
const baseCache = new Map<string, BaseEntry>()
const BASE_MAX = 40
// …and a total-pixel budget on top: raster width follows the quality
// tier, so at 3–6 Mpx per page a pure count cap would let an ultra-tier
// cache balloon past a gigabyte of canvases.
const BASE_BUDGET_PX = 60_000_000

const baseKey = (page: Page, width: number) => `${page.id}|${width}`

function evictBases() {
  let total = 0
  for (const e of baseCache.values()) total += e.canvas.width * e.canvas.height
  console.log('evictBases total', total, 'size', baseCache.size)
  while (baseCache.size > 1 && (baseCache.size > BASE_MAX || total > BASE_BUDGET_PX)) {
    const oldest = baseCache.keys().next().value
    if (oldest === undefined) break
    const entry = baseCache.get(oldest)!
    total -= entry.canvas.width * entry.canvas.height
    baseCache.delete(oldest)
    log.debug('base raster evicted', oldest)
  }
}

// Shared content raster for `page` at `width`. Repaints when the page's
// revision moved on, or when `force` (a photo op may have finished decoding
// since the last paint). Returns null where 2D canvas is unavailable.
export function baseCanvas(
  page: Page,
  ink: InkEngine,
  width: number,
  force = false,
): HTMLCanvasElement | null {
  const key = baseKey(page, width)
  const hit = baseCache.get(key)
  const rev = pageRev(page)
  if (hit && !force && hit.rev === rev) {
    baseCache.delete(key) // LRU: reinsert as most-recently-used
    baseCache.set(key, hit)
    return hit.canvas
  }
  const canvas = hit?.canvas ?? document.createElement('canvas')
  canvas.width = width
  canvas.height = Math.round(width * PAGE_ASPECT)
  const ctx = hit?.ctx ?? canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) {
    baseCache.delete(key)
    log.debug('no 2d context for page raster', key)
    return null
  }
  log.debug('page base repainted', { key, rev, force })
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.restore()
  paintContent(canvas, ctx, page, ink, force)
  baseCache.delete(key)
  baseCache.set(key, { canvas, ctx, rev })
  evictBases()
  return canvas
}

// Offscreen snapshot of a page: cached content raster + shading overlays.
// null when 2D is unavailable (jsdom).
export function pageCanvas(
  page: Page,
  ink: InkEngine,
  width = 512,
  fold?: boolean,
  edgeShade?: boolean,
): HTMLCanvasElement | null {
  const base = baseCanvas(page, ink, width)
  if (!base) return null
  const c = document.createElement('canvas')
  c.width = base.width
  c.height = base.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(base, 0, 0)
  paintOverlays(c, ctx, fold, edgeShade)
  return c
}

// Repaint an already-created variant canvas in place. Photo ops can finish
// decoding after the first paint; `forceBase` refreshes the shared content
// raster first (dedupe force-refreshes across variants of the same page —
// only the first call in a refresh pass needs it).
export function repaintInto(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  page: Page,
  ink: InkEngine,
  fold?: boolean,
  edgeShade?: boolean,
  forceBase = false,
) {
  const base = baseCanvas(page, ink, canvas.width, forceBase)
  if (!base) return
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(base, 0, 0)
  ctx.restore()
  paintOverlays(canvas, ctx, fold, edgeShade)
}
