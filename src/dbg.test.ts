import { it, expect } from 'vitest'
import { baseCanvas } from './three/pageTexture'
import { jsEngine } from './ink/engine'
import type { InkEngine, Page } from './types'

const line = (x0: number, x1: number): Page['strokes'][number] => ({
  tool: 'draw',
  color: '#22221f',
  pts: [
    { x: x0, y: 400, t: 0, p: 0.5 },
    { x: (x0 + x1) / 2, y: 400, t: 16, p: 0.5 },
    { x: x1, y: 400, t: 32, p: 0.5 },
  ],
})

it('dbg eviction', () => {
  const realGetContext = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = (() => ({
    fillStyle: '#000',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    save() {},
    restore() {},
    setTransform() {},
    clearRect() {},
    drawImage() {},
    fillRect() {},
    beginPath() {},
    closePath() {},
    rect() {},
    clip() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    fill() {},
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext
  try {
    const eng = jsEngine()
    let n = 0
    const spy: InkEngine = {
      begin: (tool: string, size?: number, stab?: number) => {
        n++
        return eng.begin(tool, size, stab)
      },
      addPoint: eng.addPoint,
      predict: eng.predict,
      end: eng.end,
      tail: eng.tail,
    } as InkEngine
    const mk = (id: string): Page => ({ id, strokes: [line(0, 200)], createdAt: 0 })
    const pages = Array.from({ length: 14 }, (_, i) => mk(`evict-${i}`))
    for (const p of pages) baseCanvas(p, spy, 3072)
    console.log('count after inserts:', n)
    baseCanvas(pages[0], spy, 3072)
    console.log('count after pages[0]:', n)
    baseCanvas(pages[13], spy, 3072)
    console.log('count after pages[13]:', n)
  } finally {
    HTMLCanvasElement.prototype.getContext = realGetContext
  }
  expect(true).toBe(true)
})
