interface V {
  x: number
  y: number
}

// Ramer-Douglas-Peucker polyline simplification.
export function rdp(pts: V[], eps: number): V[] {
  if (pts.length < 3) return pts.slice()
  const a = pts[0]
  const b = pts[pts.length - 1]
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  let dmax = 0
  let idx = -1
  for (let i = 1; i < pts.length - 1; i++) {
    const d =
      len < 1e-6
        ? Math.hypot(pts[i].x - a.x, pts[i].y - a.y)
        : Math.abs(dy * pts[i].x - dx * pts[i].y + b.x * a.y - b.y * a.x) / len
    if (d > dmax) {
      dmax = d
      idx = i
    }
  }
  if (dmax <= eps || idx < 0) return [a, b]
  const left = rdp(pts.slice(0, idx + 1), eps)
  const right = rdp(pts.slice(idx), eps)
  return left.slice(0, -1).concat(right)
}
