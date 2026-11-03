import type { Sample, ToolId } from '../types'

function hexToRgb(hex: string): [number, number, number] {
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

// Small deterministic PRNG so replayed pencil strokes look identical.
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Quad between two samples, perpendicular offset by half-width.
function quadPath(ctx: CanvasRenderingContext2D, a: Sample, b: Sample) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  const nx = -dy / len
  const ny = dx / len
  ctx.beginPath()
  ctx.moveTo(a.x + nx * a.w, a.y + ny * a.w)
  ctx.lineTo(b.x + nx * b.w, b.y + ny * b.w)
  ctx.lineTo(b.x - nx * b.w, b.y - ny * b.w)
  ctx.lineTo(a.x - nx * a.w, a.y - ny * a.w)
  ctx.closePath()
}

// Fill small overlap circles so joints don't show seams.
function joint(ctx: CanvasRenderingContext2D, s: Sample) {
  ctx.beginPath()
  ctx.arc(s.x, s.y, s.w, 0, Math.PI * 2)
  ctx.fill()
}

function renderSolid(ctx: CanvasRenderingContext2D, color: string, samples: Sample[]) {
  const [r, g, b] = hexToRgb(color)
  ctx.fillStyle = `rgba(${r},${g},${b},1)`
  let prev: Sample | null = null
  for (const s of samples) {
    ctx.globalAlpha = s.a
    if (prev) {
      quadPath(ctx, prev, s)
      ctx.fill()
      joint(ctx, s)
    } else {
      joint(ctx, s) // round cap at stroke start
    }
    prev = s
  }
  ctx.globalAlpha = 1
}

function renderPencil(
  ctx: CanvasRenderingContext2D,
  color: string,
  samples: Sample[],
  seed: number,
) {
  const [r, g, b] = hexToRgb(color)
  const rand = mulberry32(seed)
  ctx.fillStyle = `rgb(${r},${g},${b})`
  let prev: Sample | null = null
  for (const s of samples) {
    if (!prev) {
      prev = s
      continue
    }
    const dist = Math.hypot(s.x - prev.x, s.y - prev.y)
    const stamps = Math.max(1, Math.floor(dist / 1.2))
    for (let i = 0; i < stamps; i++) {
      const t = i / stamps
      const x = prev.x + (s.x - prev.x) * t + (rand() - 0.5) * s.w * 1.4
      const y = prev.y + (s.y - prev.y) * t + (rand() - 0.5) * s.w * 1.4
      ctx.globalAlpha = 0.04 + rand() * 0.1 * s.a
      ctx.beginPath()
      ctx.arc(x, y, 0.4 + rand() * s.w * 0.35, 0, Math.PI * 2)
      ctx.fill()
    }
    prev = s
  }
  ctx.globalAlpha = 1
}

function renderWatercolor(ctx: CanvasRenderingContext2D, color: string, samples: Sample[]) {
  const [r, g, b] = hexToRgb(color)
  const prevComp = ctx.globalCompositeOperation
  ctx.globalCompositeOperation = 'multiply'
  let prev: Sample | null = null
  for (const s of samples) {
    if (!prev) {
      prev = s
      continue
    }
    const dist = Math.hypot(s.x - prev.x, s.y - prev.y)
    const stamps = Math.max(1, Math.floor(dist / Math.max(s.w * 0.12, 0.6)))
    for (let i = 0; i < stamps; i++) {
      const t = i / stamps
      const x = prev.x + (s.x - prev.x) * t
      const y = prev.y + (s.y - prev.y) * t
      const grad = ctx.createRadialGradient(x, y, 0, x, y, s.w)
      grad.addColorStop(0, `rgba(${r},${g},${b},${s.a})`)
      grad.addColorStop(0.7, `rgba(${r},${g},${b},${s.a * 0.7})`)
      grad.addColorStop(1, `rgba(${r},${g},${b},0)`)
      ctx.fillStyle = grad
      ctx.beginPath()
      ctx.arc(x, y, s.w, 0, Math.PI * 2)
      ctx.fill()
    }
    prev = s
  }
  ctx.globalCompositeOperation = prevComp
}

function renderEraser(ctx: CanvasRenderingContext2D, samples: Sample[]) {
  const prevComp = ctx.globalCompositeOperation
  ctx.globalCompositeOperation = 'destination-out'
  let prev: Sample | null = null
  ctx.fillStyle = '#000'
  for (const s of samples) {
    if (prev) {
      quadPath(ctx, prev, s)
      ctx.fill()
      joint(ctx, s)
    } else {
      joint(ctx, s)
    }
    prev = s
  }
  ctx.globalCompositeOperation = prevComp
}

export function renderSamples(
  ctx: CanvasRenderingContext2D,
  tool: ToolId,
  color: string,
  samples: Sample[],
  seed = 1,
  widthScale = 1,
) {
  if (!samples.length) return
  if (widthScale !== 1) samples = samples.map((sample) => ({ ...sample, w: sample.w * widthScale }))
  switch (tool) {
    case 'sketch':
      renderPencil(ctx, color, samples, seed)
      break
    case 'color':
      renderWatercolor(ctx, color, samples)
      break
    case 'eraser':
      renderEraser(ctx, samples)
      break
    default:
      renderSolid(ctx, color, samples)
  }
}
