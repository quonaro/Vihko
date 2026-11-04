import type { BrushParams, BrushTip, Sample, ToolId } from '../types'

// Brush options attached to a stroke at draw time; see Stroke/BrushParams.
export type BrushOpts = Partial<
  Pick<BrushParams, 'opacity' | 'blend' | 'tip' | 'spacing' | 'jitter' | 'scatter' | 'angle'>
>

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

// Fill a small circle — used for caps at the outline ends and for dots.
function joint(ctx: CanvasRenderingContext2D, s: Sample) {
  ctx.beginPath()
  ctx.arc(s.x, s.y, s.w, 0, Math.PI * 2)
  ctx.fill()
}

// Single filled polygon tracing the stroke outline: left edge forward, right
// edge back, joined by round caps. One fill per batch instead of overlapping
// quads+joints — no internal seams where the width changes (tapers).
function outlinePath(ctx: CanvasRenderingContext2D, samples: Sample[]) {
  const n = samples.length
  const normal = (i: number) => {
    const a = samples[Math.max(0, i - 1)]
    const b = samples[Math.min(n - 1, i + 1)]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy) || 1
    return { x: -dy / len, y: dx / len }
  }
  ctx.beginPath()
  for (let i = 0; i < n; i++) {
    const s = samples[i]
    const v = normal(i)
    const x = s.x + v.x * s.w
    const y = s.y + v.y * s.w
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  for (let i = n - 1; i >= 0; i--) {
    const s = samples[i]
    const v = normal(i)
    ctx.lineTo(s.x - v.x * s.w, s.y - v.y * s.w)
  }
  ctx.closePath()
}

function renderSolid(ctx: CanvasRenderingContext2D, color: string, samples: Sample[]) {
  const [r, g, b] = hexToRgb(color)
  ctx.globalAlpha = samples[0].a
  ctx.fillStyle = `rgb(${r},${g},${b})`
  outlinePath(ctx, samples)
  ctx.fill()
  joint(ctx, samples[0]) // round caps
  if (samples.length > 1) joint(ctx, samples[samples.length - 1])
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
  ctx.fillStyle = '#000'
  outlinePath(ctx, samples)
  ctx.fill()
  joint(ctx, samples[0])
  if (samples.length > 1) joint(ctx, samples[samples.length - 1])
  ctx.globalCompositeOperation = prevComp
}

// --- texture stamps -------------------------------------------------------
// Procedural grayscale tip sprites tinted per color (cached). The stamp is
// drawn along the stroke centerline every `spacing` diameters; jitter/scatter
// randomize size/alpha/position; angle rotates the stamp with the stroke.
const stampCache = new Map<string, HTMLCanvasElement>()

function stampSprite(tip: BrushTip, color: string): HTMLCanvasElement | null {
  const key = `${tip}|${color}`
  const hit = stampCache.get(key)
  if (hit) return hit
  const c = document.createElement('canvas')
  c.width = 96
  c.height = 96
  const t = c.getContext('2d')
  if (!t) return null
  const r = 44
  if (tip === 'airbrush') {
    const g = t.createRadialGradient(48, 48, 0, 48, 48, r)
    g.addColorStop(0, 'rgba(255,255,255,0.9)')
    g.addColorStop(0.6, 'rgba(255,255,255,0.45)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    t.fillStyle = g
    t.fillRect(0, 0, 96, 96)
  } else if (tip === 'marker') {
    // Chisel nib: rotated square clipped to the sprite.
    t.save()
    t.translate(48, 48)
    t.rotate(Math.PI / 4)
    t.fillStyle = 'rgba(255,255,255,0.85)'
    t.fillRect(-r, -r * 0.55, r * 2, r * 1.1)
    t.restore()
  } else {
    // 'noise': grainy dot — a dense speckle of small arcs.
    const rand = mulberry32(7)
    t.fillStyle = 'rgba(255,255,255,0.6)'
    for (let i = 0; i < 260; i++) {
      const a = rand() * Math.PI * 2
      const d = Math.sqrt(rand()) * r
      t.globalAlpha = 0.15 + rand() * 0.55
      t.beginPath()
      t.arc(48 + Math.cos(a) * d, 48 + Math.sin(a) * d, 0.6 + rand() * 1.8, 0, Math.PI * 2)
      t.fill()
    }
    t.globalAlpha = 1
  }
  // Tint the white sprite to the stroke color, keeping alpha.
  t.globalCompositeOperation = 'source-in'
  t.fillStyle = color
  t.fillRect(0, 0, 96, 96)
  stampCache.set(key, c)
  if (stampCache.size > 64) stampCache.delete(stampCache.keys().next().value!)
  return c
}

function renderStamped(
  ctx: CanvasRenderingContext2D,
  color: string,
  samples: Sample[],
  seed: number,
  brush: BrushOpts,
  erase: boolean,
) {
  const sprite = stampSprite(brush.tip!, erase ? '#000000' : color)
  if (!sprite) {
    if (erase) renderEraser(ctx, samples)
    else renderSolid(ctx, color, samples)
    return
  }
  const rand = mulberry32(seed)
  const spacing = Math.max(0.05, brush.spacing ?? 0.3)
  const jitter = brush.jitter ?? 0
  const scatter = brush.scatter ?? 0
  const followAngle = !!brush.angle
  let carry = 0
  ctx.save()
  ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over'
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]
    const b = samples[i]
    const dist = Math.hypot(b.x - a.x, b.y - a.y)
    const step = Math.max(0.6, b.w * 2 * spacing)
    let d0 = carry
    const dir = Math.atan2(b.y - a.y, b.x - a.x)
    while (d0 < dist) {
      const t = d0 / dist
      const w = a.w + (b.w - a.w) * t
      const alpha = a.a + (b.a - a.a) * t
      const x = a.x + (b.x - a.x) * t
      const y = a.y + (b.y - a.y) * t
      const d = Math.max(0.5, w * 2 * (1 + jitter * (rand() - 0.5) * 1.6))
      const off = scatter * w * (rand() - 0.5) * 2
      const ox = off * -Math.sin(dir)
      const oy = off * Math.cos(dir)
      ctx.globalAlpha = Math.min(1, alpha * (1 - jitter * rand() * 0.8))
      if (followAngle || brush.tip === 'marker') {
        ctx.save()
        ctx.translate(x + ox, y + oy)
        ctx.rotate(followAngle ? dir : 0)
        ctx.drawImage(sprite, -d / 2, -d / 2, d, d)
        ctx.restore()
      } else {
        ctx.drawImage(sprite, x + ox - d / 2, y + oy - d / 2, d, d)
      }
      d0 += step
    }
    carry = d0 - dist
  }
  ctx.restore()
  ctx.globalAlpha = 1
}

export function renderSamples(
  ctx: CanvasRenderingContext2D,
  tool: ToolId,
  color: string,
  samples: Sample[],
  seed = 1,
  widthScale = 1,
  brush?: BrushOpts,
) {
  if (!samples.length) return
  if (widthScale !== 1) samples = samples.map((sample) => ({ ...sample, w: sample.w * widthScale }))
  const opacity = brush?.opacity ?? 1
  const erase = tool === 'eraser'
  ctx.save()
  if (brush?.blend) ctx.globalCompositeOperation = erase ? 'destination-out' : brush.blend
  if (opacity !== 1) samples = samples.map((s) => ({ ...s, a: s.a * opacity }))
  if (brush?.tip && brush.tip !== 'round') {
    renderStamped(ctx, color, samples, seed, brush, erase)
  } else {
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
  ctx.restore()
}
