import type { Pt, ShapeKind } from '../types'

type Point = Pick<Pt, 'x' | 'y'>

function withTime(points: Point[]): Pt[] {
  return points.map(({ x, y }, i) => ({ x, y, t: i * 16, p: 0.5 }))
}

export function shapePoints(shape: ShapeKind, start: Point, end: Point): Pt[] {
  const left = Math.min(start.x, end.x)
  const right = Math.max(start.x, end.x)
  const top = Math.min(start.y, end.y)
  const bottom = Math.max(start.y, end.y)
  const midX = (left + right) / 2
  const midY = (top + bottom) / 2

  switch (shape) {
    case 'line':
      return withTime([start, end])
    case 'arrow': {
      const angle = Math.atan2(end.y - start.y, end.x - start.x)
      const length = Math.min(18, Math.hypot(end.x - start.x, end.y - start.y) * 0.35)
      const wing = (offset: number) => ({
        x: end.x - length * Math.cos(angle + offset),
        y: end.y - length * Math.sin(angle + offset),
      })
      return withTime([start, end, wing(-0.55), end, wing(0.55)])
    }
    case 'rectangle':
      return withTime([
        { x: left, y: top },
        { x: right, y: top },
        { x: right, y: bottom },
        { x: left, y: bottom },
        { x: left, y: top },
      ])
    case 'triangle':
      return withTime([
        { x: midX, y: top },
        { x: right, y: bottom },
        { x: left, y: bottom },
        { x: midX, y: top },
      ])
    case 'diamond':
      return withTime([
        { x: midX, y: top },
        { x: right, y: midY },
        { x: midX, y: bottom },
        { x: left, y: midY },
        { x: midX, y: top },
      ])
    case 'ellipse': {
      const rx = (right - left) / 2
      const ry = (bottom - top) / 2
      const points = Array.from({ length: 49 }, (_, i) => {
        const angle = (i / 48) * Math.PI * 2
        return { x: midX + rx * Math.cos(angle), y: midY + ry * Math.sin(angle) }
      })
      return withTime(points)
    }
  }
}
