import type { SpreadMode } from './types'

// Canonical page coordinate space. Stroke points, raster-op coordinates and
// photo placements are all stored in page units: a fixed-size landscape sheet
// (a two-page spread, fold down the middle) that the journal stack/overview
// views sample as PAGE_W x PAGE_H world units. The editor viewport is a
// window onto this sheet — see coverViewport.
export const PAGE_UNIT = 600 / 0.28
export const PAGE_ASPECT = 380 / 600 // two portrait halves, one continuous spread
export const PAGE_W = PAGE_UNIT
export const PAGE_H = PAGE_UNIT * PAGE_ASPECT

// Pages may declare their own size in page units; absent fields mean the
// canonical spread. `pageSize` normalizes that everywhere it's needed.
export interface PageSize {
  w: number
  h: number
}
export function pageSize(page?: { w?: number; h?: number } | null): PageSize {
  return {
    w: page?.w && page.w > 0 ? page.w : PAGE_W,
    h: page?.h && page.h > 0 ? page.h : PAGE_H,
  }
}

// Named presets offered when a new page is created (page units; spread = the
// canonical two-page landscape sheet).
export const PAGE_SIZE_PRESETS = [
  { id: 'spread', w: PAGE_W, h: PAGE_H },
  { id: 'portrait', w: PAGE_W / 2, h: PAGE_H },
  { id: 'square', w: PAGE_H, h: PAGE_H },
] as const
export type PageSizeId = (typeof PAGE_SIZE_PRESETS)[number]['id']
export function pageSizePreset(id: string): PageSize {
  return PAGE_SIZE_PRESETS.find((p) => p.id === id) ?? PAGE_SIZE_PRESETS[0]
}

// The editor's working rect in page units. A landscape sheet under the
// 'left'/'right' spread focus crops to that half; anything else gets the
// whole sheet. Strokes keep full page coordinates — the rect only bounds
// the viewport framing and the paint clip.
export function spreadRect(
  mode: SpreadMode,
  w: number,
  h: number,
): { x: number; y: number; w: number; h: number } {
  if (w <= h || mode === 'full') return { x: 0, y: 0, w, h }
  return { x: mode === 'right' ? w / 2 : 0, y: 0, w: w / 2, h }
}

export interface Viewport {
  s: number // css px per page unit
  ox: number // css px offset of the page origin (<= 0 when overflowing)
  oy: number
}

// Cover fit: the smallest uniform scale at which the sheet still fills the
// viewport. On aspect-mismatched screens the sheet overflows one axis and the
// excess is reachable by free panning.
export function coverViewport(cssW: number, cssH: number, size?: PageSize): Viewport {
  const { w: pw, h: ph } = size ?? { w: PAGE_W, h: PAGE_H }
  const s = Math.max(cssW / pw, cssH / ph)
  return {
    s,
    ox: (cssW - pw * s) / 2,
    oy: (cssH - ph * s) / 2,
  }
}
