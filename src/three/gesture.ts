// Pure drag/fling math shared by the WebGL scenes (shelf row, page fan,
// spread turns). There is no native scroller inside a canvas, so the
// gesture itself has to feel like one: rubber-band resistance past the
// ends while the finger is down, and flick momentum after release.

// Fraction of the overshoot kept while dragging past a scroll limit
// (0 = hard stop, 1 = no resistance).
export const RUBBER_BAND = 0.32

export function rubberScroll(raw: number, limit: number): number {
  const c = Math.max(-limit, Math.min(limit, raw))
  return c + (raw - c) * RUBBER_BAND
}

// A flick only counts the motion of the last ~110ms — a finger held still
// before lifting must not launch anything.
export const FLICK_WINDOW_MS = 110

// Horizontal pointer velocity in px/s from a move trail ({x, t: ms}), or 0
// when there is too little recent motion to trust a flick.
export function flickVelocity(trail: readonly { x: number; t: number }[], now: number): number {
  const recent = trail.filter((s) => now - s.t <= FLICK_WINDOW_MS)
  if (recent.length < 2) return 0
  const dt = recent[recent.length - 1].t - recent[0].t
  if (dt <= 0) return 0
  return ((recent[recent.length - 1].x - recent[0].x) / dt) * 1000
}

// Momentum decay after release (scroll units/s). The flick travels
// roughly vel / MOMENTUM_DECAY units before dying out.
export const MOMENTUM_DECAY = 2.6
export const MOMENTUM_MIN = 0.06 // below this the motion is considered stopped

// Integrate one momentum step; returns the updated {pos, vel}. Hitting a
// scroll limit stops the fling instead of bouncing.
export function momentumStep(
  pos: number,
  vel: number,
  limit: number,
  dt: number,
): { pos: number; vel: number } {
  const next = Math.max(-limit, Math.min(limit, pos + vel * dt))
  return { pos: next, vel: next === pos + vel * dt ? vel * Math.exp(-MOMENTUM_DECAY * dt) : 0 }
}

// Two-finger pinch zooms the camera along its look-axis; the clamp keeps
// the journal from shrinking past readability or flying through the lens.
export const ZOOM_MIN = 0.55
export const ZOOM_MAX = 3.4

export function clampZoom(z: number): number {
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z))
}

// New zoom for a pinch: the finger-span ratio d/d0 multiplies the zoom
// captured at gesture start, so re-pinching never jumps.
export function pinchZoom(zoom0: number, d0: number, d: number): number {
  return clampZoom(zoom0 * (d / Math.max(1, d0)))
}

// Panning (pinch-midpoint travel, or a one-finger drag while zoomed)
// slides the camera and its look target together in the view plane. The
// limit grows with zoom — at fit (zoom 1) it is zero, so zooming back out
// recenters the journal instead of leaving it parked off-screen.
export const PAN_LIMIT = 1.7 // world units, as zoom → ∞

export function panLimit(zoom: number): number {
  return PAN_LIMIT * Math.max(0, 1 - 1 / zoom)
}

// Clamp a screen-plane pan offset (x right, y up, world units) to the
// limit for the current zoom.
export function clampPan(x: number, y: number, zoom: number): [number, number] {
  const lim = panLimit(zoom)
  const l = Math.hypot(x, y)
  return l > lim && l > 0 ? [(x * lim) / l, (y * lim) / l] : [x, y]
}
