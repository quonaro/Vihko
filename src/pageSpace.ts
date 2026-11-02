// Canonical page coordinate space. Stroke points, raster-op coordinates and
// photo placements are all stored in page units: a fixed-size landscape sheet
// (a two-page spread, fold down the middle) that the journal stack/overview
// views sample as PAGE_W x PAGE_H world units. The editor viewport is a
// window onto this sheet — see coverViewport/clampOffset.
export const PAGE_UNIT = 600 / 0.28
export const PAGE_ASPECT = 380 / 600 // two portrait halves, one continuous spread
export const PAGE_W = PAGE_UNIT
export const PAGE_H = PAGE_UNIT * PAGE_ASPECT

export interface Viewport {
  s: number // css px per page unit
  ox: number // css px offset of the page origin (<= 0 when overflowing)
  oy: number
}

// Cover fit: the smallest uniform scale at which the sheet still fills the
// viewport. On aspect-mismatched screens the sheet overflows one axis and the
// excess is reachable by panning (clamped by clampOffset).
export function coverViewport(cssW: number, cssH: number): Viewport {
  const s = Math.max(cssW / PAGE_W, cssH / PAGE_H)
  return {
    s,
    ox: (cssW - PAGE_W * s) / 2,
    oy: (cssH - PAGE_H * s) / 2,
  }
}

// Keep the sheet covering the viewport: on each axis the offset ranges from
// (css - sheet) up to 0; where the sheet fits inside the viewport (zoomed out)
// it is centered instead.
export function clampOffset(
  ox: number,
  oy: number,
  s: number,
  cssW: number,
  cssH: number,
): { ox: number; oy: number } {
  const cl = (v: number, css: number, page: number) => {
    const sheet = page * s
    if (sheet <= css) return (css - sheet) / 2
    return Math.min(0, Math.max(css - sheet, v))
  }
  return { ox: cl(ox, cssW, PAGE_W), oy: cl(oy, cssH, PAGE_H) }
}
