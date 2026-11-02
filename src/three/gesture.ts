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
export function flickVelocity(
  trail: readonly { x: number; t: number }[],
  now: number,
): number {
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
