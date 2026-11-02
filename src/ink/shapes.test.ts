import { describe, expect, it } from 'vitest'
import { shapePoints } from './shapes'

describe('shapePoints', () => {
  const start = { x: 10, y: 20 }
  const end = { x: 110, y: 80 }

  it.each(['rectangle', 'triangle', 'diamond'] as const)('%s closes its outline', (shape) => {
    const points = shapePoints(shape, start, end)
    expect(points[0].x).toBe(points.at(-1)?.x)
    expect(points[0].y).toBe(points.at(-1)?.y)
  })

  it('keeps a line endpoint-to-endpoint', () => {
    expect(shapePoints('line', start, end)).toMatchObject([
      { x: 10, y: 20 },
      { x: 110, y: 80 },
    ])
  })

  it('builds an arrow with two head strokes at the endpoint', () => {
    const points = shapePoints('arrow', start, end)
    expect(points[1]).toMatchObject(end)
    expect(points[3]).toMatchObject(end)
    expect(points[2]).not.toMatchObject(end)
    expect(points[4]).not.toMatchObject(end)
  })

  it('samples an ellipse around the dragged bounds', () => {
    const points = shapePoints('ellipse', start, end)
    expect(points).toHaveLength(49)
    expect(Math.min(...points.map((p) => p.x))).toBeCloseTo(10)
    expect(Math.max(...points.map((p) => p.x))).toBeCloseTo(110)
    expect(Math.min(...points.map((p) => p.y))).toBeCloseTo(20)
    expect(Math.max(...points.map((p) => p.y))).toBeCloseTo(80)
  })
})
