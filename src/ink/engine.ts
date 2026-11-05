import { logger } from '../log'
import type { InkEngine, Sample } from '../types'

const log = logger('ink')

declare global {
  interface Window {
    Go?: new () => {
      importObject: WebAssembly.Imports
      run(instance: WebAssembly.Instance): Promise<void>
    }
    Ink?: {
      begin(tool: string, size?: number, stab?: number): number
      addPoint(id: number, x: number, y: number, t: number, p: number): Sample[]
      predict(id: number, x: number, y: number, t: number, p: number): Sample[]
      end(id: number): Sample[]
      floodFill?(
        data: Uint8ClampedArray,
        w: number,
        h: number,
        x: number,
        y: number,
        r: number,
        g: number,
        b: number,
        tol: number,
        pr: number,
        pg: number,
        pb: number,
        athresh: number,
      ): number
      boxBlur?(data: Uint8ClampedArray, w: number, h: number, radius: number): void
      sharpen?(data: Uint8ClampedArray, w: number, h: number, amount: number): void
      adjust?(
        data: Uint8ClampedArray,
        brightness: number,
        contrast: number,
        saturation: number,
      ): void
      wetStroke?(
        data: Uint8ClampedArray,
        w: number,
        h: number,
        dabs: number[],
        r: number,
        g: number,
        b: number,
        pickup: number,
      ): void
    }
  }
}

// Pure-JS fallback mirroring engine/ink.go (a port of the perfect-freehand
// stroke model — streamline input smoothing, real-or-simulated pressure,
// radius = dia*(0.5 - thinning*(0.5-p)), start/end tapers) so the app still
// works if the wasm binary fails to load. Keep both sides in lockstep; the
// tests assert the same magic values.

interface Pt {
  x: number
  y: number
  t: number
  p: number
}

interface PendSample extends Sample {
  rl: number
}

interface Profile {
  dia: number
  thinning: number
  streamline: number
  taperStart: number
  taperEnd: number
  alpha: number
}

const profile = (tool: string): Profile => {
  switch (tool) {
    case 'draw':
      return {
        dia: 3.6,
        thinning: 0.75,
        streamline: 0.5,
        taperStart: 2.0,
        taperEnd: 1.5,
        alpha: 0.92,
      }
    case 'write':
      return { dia: 4.4, thinning: 0.1, streamline: 0.5, taperStart: 0, taperEnd: 0, alpha: 1.0 }
    case 'shapes':
      return { dia: 4.4, thinning: 0, streamline: 0, taperStart: 0, taperEnd: 0, alpha: 1.0 }
    case 'outline':
      return { dia: 13, thinning: 0.1, streamline: 0.45, taperStart: 0, taperEnd: 0.5, alpha: 0.95 }
    case 'sketch':
      return {
        dia: 4.8,
        thinning: 0.6,
        streamline: 0.55,
        taperStart: 1.5,
        taperEnd: 1.0,
        alpha: 0.6,
      }
    case 'color':
      return {
        dia: 24,
        thinning: 0.9,
        streamline: 0.6,
        taperStart: 0.75,
        taperEnd: 0,
        alpha: 0.045,
      }
    case 'eraser':
      return { dia: 26, thinning: 0, streamline: 0.4, taperStart: 0, taperEnd: 0, alpha: 1.0 }
    default:
      log.debug('profile: unknown tool, using defaults', tool)
      return { dia: 5, thinning: 0.5, streamline: 0.5, taperStart: 0, taperEnd: 0, alpha: 1 }
  }
}

// The widest diameter a tool can paint at size multiplier 1, in page units:
// real or speed-simulated pressure widens a stroke to dia*(1+thinning), so
// the desktop brush cursor ring tracks the painted footprint, not the
// pressure-0.5 nominal.
export const toolMaxDia = (tool: string): number => {
  const p = profile(tool)
  return p.dia * (1 + p.thinning)
}

const RATE_OF_PRESSURE_CHANGE = 0.275
const REAL_PRESSURE_DELTA = 0.04
const MIN_GAP = 0.25
const MIN_W = 0.05

interface Stroke {
  prof: Profile
  dia: number
  tInterp: number
  pts: Pt[]
  prev: Pt
  hasPrev: boolean
  firstP: number
  prevP: number
  realP: boolean
  rl: number
  minOK: boolean
  lastW: number
  buf: PendSample[]
  emitted: boolean
}

const newStroke = (tool: string, size: number, stab: number): Stroke => {
  const prof = profile(tool)
  const sl = stab >= 0 ? Math.min(0.95, Math.max(0, stab)) : prof.streamline
  return {
    prof,
    dia: prof.dia * (size > 0 ? size : 1),
    tInterp: 0.15 + (1 - sl) * 0.85,
    pts: [],
    prev: { x: 0, y: 0, t: 0, p: 0 },
    hasPrev: false,
    firstP: 0,
    prevP: 0,
    realP: false,
    rl: 0,
    minOK: false,
    lastW: 0,
    buf: [],
    emitted: false,
  }
}

const minLen = (s: Stroke) => Math.min(Math.max(s.dia * 0.5, 1.5), 10)

const pressureFor = (s: Stroke, p: Pt, dist: number) => {
  if (!s.realP && Math.abs(p.p - s.firstP) > REAL_PRESSURE_DELTA) {
    s.realP = true
    log.debug('real stylus pressure detected, switching off speed simulation')
  }
  if (s.realP) {
    s.prevP += (p.p - s.prevP) * 0.6
    return s.prevP
  }
  const sp = Math.min(1, dist / s.dia)
  const rp = Math.min(1, 1 - sp)
  s.prevP = Math.min(1, s.prevP + (rp - s.prevP) * (sp * RATE_OF_PRESSURE_CHANGE))
  return s.prevP
}

const widthFor = (s: Stroke, pr: number) => {
  let w = s.prof.dia * (0.5 - s.prof.thinning * (0.5 - pr))
  const ts = s.prof.taperStart * s.dia
  if (ts > 0 && s.rl < ts) {
    const f = s.rl / ts
    w *= Math.max(0.02, f * (2 - f))
  }
  return Math.max(MIN_W, w)
}

const buffer = (s: Stroke, x: number, y: number, rl: number, w: number, out: Sample[]) => {
  s.buf.push({ x, y, w, a: s.prof.alpha, rl })
  const te = s.prof.taperEnd * s.dia
  while (s.buf.length && s.rl - s.buf[0].rl >= te) {
    const { rl: _rl, ...sm } = s.buf.shift()!
    out.push(sm)
    s.emitted = true
  }
}

const feed = (s: Stroke, p: Pt, last: boolean, out: Sample[]) => {
  if (!s.hasPrev) {
    s.hasPrev = true
    s.prev = p
    s.prevP = p.p
    s.firstP = p.p
    const w = widthFor(s, p.p)
    s.lastW = w
    buffer(s, p.x, p.y, 0, w, out)
    return
  }
  let ax = p.x
  let ay = p.y
  if (!last) {
    ax = s.prev.x + (p.x - s.prev.x) * s.tInterp
    ay = s.prev.y + (p.y - s.prev.y) * s.tInterp
  }
  const dist = Math.hypot(ax - s.prev.x, ay - s.prev.y)
  if (dist < MIN_GAP && !last) return
  const prevRL = s.rl
  s.rl += dist
  if (!s.minOK && !last && s.rl < minLen(s)) return
  s.minOK = true
  log.debug('stroke passed the min-length noise gate')

  const pr = pressureFor(s, p, dist)
  const w = widthFor(s, pr)

  const step = Math.max(2, 0.3 * s.dia)
  const n = Math.max(1, Math.ceil(dist / step))
  for (let k = 1; k <= n; k++) {
    const f = k / n
    buffer(
      s,
      s.prev.x + (ax - s.prev.x) * f,
      s.prev.y + (ay - s.prev.y) * f,
      prevRL + dist * f,
      s.lastW + (w - s.lastW) * f,
      out,
    )
  }
  s.lastW = w
  s.prev.x = ax
  s.prev.y = ay
}

const flush = (s: Stroke): Sample[] => {
  const out: Sample[] = []
  if (s.pts.length) {
    const last = s.pts[s.pts.length - 1]
    if (Math.hypot(last.x - s.prev.x, last.y - s.prev.y) > 0) feed(s, last, true, out)
  }
  const te = s.prof.taperEnd * s.dia
  for (const e of s.buf) {
    if (te > 0) {
      const rem = s.rl - e.rl
      if (rem < te) {
        const f = Math.max(0, rem / te)
        e.w *= Math.max(0.02, 1 - (1 - f) * (1 - f) * (1 - f))
        if (e.w < MIN_W) e.w = MIN_W
      }
    }
    const { rl: _rl, ...sm } = e
    out.push(sm)
  }
  s.buf = []
  if (s.hasPrev && s.rl < minLen(s)) {
    log.debug('stroke below min length, emitting a tap dot')
    const w = s.prof.dia * (0.5 - s.prof.thinning * (0.5 - s.prevP))
    out.length = 0
    out.push({ x: s.prev.x, y: s.prev.y, w: Math.max(MIN_W, w), a: s.prof.alpha })
  }
  if (out.length) s.emitted = true
  return out
}

// --- pixel kernels ---------------------------------------------------------
// JS mirror of engine/px.go — identical math on ImageData-style buffers
// (straight RGBA). floodFill treats pixels with alpha < athresh as paper.

const c8 = (v: number) => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v))
const absI = (v: number) => (v < 0 ? -v : v)

function pxFloodFill(
  buf: Uint8ClampedArray,
  w: number,
  h: number,
  sx: number,
  sy: number,
  r: number,
  g: number,
  b: number,
  tol: number,
  pr: number,
  pg: number,
  pb: number,
  athresh: number,
): number {
  if (sx < 0 || sy < 0 || sx >= w || sy >= h || buf.length < w * h * 4) return 0
  const si = (sy * w + sx) * 4
  const [sr, sg, sb] = buf[si + 3] < athresh ? [pr, pg, pb] : [buf[si], buf[si + 1], buf[si + 2]]
  if (absI(r - sr) + absI(g - sg) + absI(b - sb) < 3) return 0
  const tol3 = tol * 3
  const erasedMatches = absI(pr - sr) + absI(pg - sg) + absI(pb - sb) <= tol3
  const match = (i: number) =>
    buf[i + 3] < athresh
      ? erasedMatches
      : absI(buf[i] - sr) + absI(buf[i + 1] - sg) + absI(buf[i + 2] - sb) <= tol3
  const visited = new Uint8Array(w * h)
  const stack: number[] = [sy * w + sx]
  visited[sy * w + sx] = 1
  let painted = 0
  while (stack.length) {
    const p = stack.pop()!
    const i = p * 4
    if (!match(i)) continue
    buf[i] = r
    buf[i + 1] = g
    buf[i + 2] = b
    buf[i + 3] = 255
    painted++
    const x = p % w
    const y = (p / w) | 0
    for (const [nx, ny] of [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ]) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
      const np = ny * w + nx
      if (!visited[np]) {
        visited[np] = 1
        stack.push(np)
      }
    }
  }
  return painted
}

function pxBlurPass(
  buf: Uint8ClampedArray,
  tmp: Float64Array,
  w: number,
  h: number,
  r: number,
  horizontal: boolean,
) {
  const dim = horizontal ? w : h
  const other = horizontal ? h : w
  const win = r * 2 + 1
  for (let o = 0; o < other; o++) {
    for (let ch = 0; ch < 3; ch++) {
      let acc = 0
      const at = (p: number) => (horizontal ? (o * w + p) * 4 : (p * w + o) * 4) + ch
      for (let i = -r; i <= r; i++) acc += buf[at(Math.min(dim - 1, Math.max(0, i)))]
      for (let i = 0; i < dim; i++) {
        tmp[i] = acc / win
        const out = Math.max(0, i - r)
        const inn = Math.min(dim - 1, i + r + 1)
        acc += buf[at(inn)] - buf[at(out)]
      }
      for (let i = 0; i < dim; i++) buf[at(i)] = c8(tmp[i])
    }
  }
}

function pxBoxBlur(buf: Uint8ClampedArray, w: number, h: number, radius: number) {
  if (radius < 1 || buf.length < w * h * 4) return
  const tmp = new Float64Array(Math.max(w, h))
  pxBlurPass(buf, tmp, w, h, radius, true)
  pxBlurPass(buf, tmp, w, h, radius, false)
}

function pxSharpen(buf: Uint8ClampedArray, w: number, h: number, amount: number) {
  if (amount <= 0 || buf.length < w * h * 4) return
  const src = Uint8ClampedArray.from(buf)
  const blur = Uint8ClampedArray.from(buf)
  pxBoxBlur(blur, w, h, 3)
  for (let i = 0; i < buf.length; i += 4) {
    for (let ch = 0; ch < 3; ch++) {
      buf[i + ch] = c8(src[i + ch] + (src[i + ch] - blur[i + ch]) * amount)
    }
  }
}

function pxAdjust(
  buf: Uint8ClampedArray,
  brightness: number,
  contrast: number,
  saturation: number,
) {
  const k = 1 + contrast
  for (let i = 0; i + 3 < buf.length; i += 4) {
    const r = buf[i] / 255
    const g = buf[i + 1] / 255
    const b = buf[i + 2] / 255
    const luma = 0.299 * r + 0.587 * g + 0.114 * b
    const adj = (v: number) => {
      v += brightness
      v = (v - 0.5) * k + 0.5
      v += (v - luma) * saturation
      return c8(v * 255)
    }
    buf[i] = adj(r)
    buf[i + 1] = adj(g)
    buf[i + 2] = adj(b)
  }
}

function pxWetStroke(
  buf: Uint8ClampedArray,
  w: number,
  h: number,
  dabs: number[],
  r: number,
  g: number,
  b: number,
  pickup: number,
) {
  const n = (dabs.length / 4) | 0
  if (!n || buf.length < w * h * 4) return
  for (let i = 0; i < n; i++) {
    const x = dabs[i * 4]
    const y = dabs[i * 4 + 1]
    const hw = dabs[i * 4 + 2]
    const alpha = dabs[i * 4 + 3]
    if (hw < 0.5 || alpha <= 0) continue
    const rad = hw * 2
    let px = x
    let py = y
    if (i + 1 < n) {
      const dx = dabs[i * 4 + 4] - x
      const dy = dabs[i * 4 + 5] - y
      const l = Math.hypot(dx, dy)
      if (l > 0) {
        px += (dx / l) * rad * 0.7
        py += (dy / l) * rad * 0.7
      }
    }
    let pr = 0
    let pg = 0
    let pb = 0
    let pw = 0
    for (let yy = Math.floor(py - rad); yy < py + rad + 1; yy++) {
      for (let xx = Math.floor(px - rad); xx < px + rad + 1; xx++) {
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue
        const d = Math.hypot(xx - px, yy - py) / rad
        if (d >= 1) continue
        const ii = (yy * w + xx) * 4
        const aw = (1 - d) * (buf[ii + 3] / 255)
        pr += buf[ii] * aw
        pg += buf[ii + 1] * aw
        pb += buf[ii + 2] * aw
        pw += aw
      }
    }
    const mr = pw > 0 ? r * (1 - pickup) + (pr / pw) * pickup : r
    const mg = pw > 0 ? g * (1 - pickup) + (pg / pw) * pickup : g
    const mb = pw > 0 ? b * (1 - pickup) + (pb / pw) * pickup : b
    for (let yy = Math.floor(y - rad); yy < y + rad + 1; yy++) {
      for (let xx = Math.floor(x - rad); xx < x + rad + 1; xx++) {
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue
        const d = Math.hypot(xx - x, yy - y) / rad
        if (d >= 1) continue
        const k = (1 - d) * alpha
        const ii = (yy * w + xx) * 4
        buf[ii] = c8(buf[ii] * (1 - k) + mr * k)
        buf[ii + 1] = c8(buf[ii + 1] * (1 - k) + mg * k)
        buf[ii + 2] = c8(buf[ii + 2] * (1 - k) + mb * k)
        buf[ii + 3] = c8(buf[ii + 3] + alpha * (1 - d) * 255 - buf[ii + 3] * alpha * (1 - d))
      }
    }
  }
}

function pxInverseFill(
  buf: Uint8ClampedArray,
  w: number,
  h: number,
  sx: number,
  sy: number,
  r: number,
  g: number,
  b: number,
  tol: number,
  pr: number,
  pg: number,
  pb: number,
  athresh: number,
): number {
  if (sx < 0 || sy < 0 || sx >= w || sy >= h || buf.length < w * h * 4) return 0
  const si = (sy * w + sx) * 4
  const [sr, sg, sb] = buf[si + 3] < athresh ? [pr, pg, pb] : [buf[si], buf[si + 1], buf[si + 2]]
  const tol3 = tol * 3
  const erasedMatches = absI(pr - sr) + absI(pg - sg) + absI(pb - sb) <= tol3
  const match = (i: number) =>
    buf[i + 3] < athresh
      ? erasedMatches
      : absI(buf[i] - sr) + absI(buf[i + 1] - sg) + absI(buf[i + 2] - sb) <= tol3
  const visited = new Uint8Array(w * h)
  const stack: number[] = [sy * w + sx]
  visited[sy * w + sx] = 1
  while (stack.length) {
    const p = stack.pop()!
    if (!match(p * 4)) continue
    const x = p % w
    const y = (p / w) | 0
    for (const [nx, ny] of [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ]) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
      const np = ny * w + nx
      if (!visited[np]) {
        visited[np] = 1
        stack.push(np)
      }
    }
  }
  let painted = 0
  for (let p = 0; p < w * h; p++) {
    const i = p * 4
    if (visited[p] && match(i)) continue
    buf[i] = r
    buf[i + 1] = g
    buf[i + 2] = b
    buf[i + 3] = 255
    painted++
  }
  return painted
}

function pxEraseColor(
  buf: Uint8ClampedArray,
  w: number,
  h: number,
  sx: number,
  sy: number,
  tol: number,
): number {
  if (sx < 0 || sy < 0 || sx >= w || sy >= h || buf.length < w * h * 4) return 0
  const si = (sy * w + sx) * 4
  const [sr, sg, sb, sa] = [buf[si], buf[si + 1], buf[si + 2], buf[si + 3]]
  const tol2 = tol * tol
  const match = (i: number) => {
    const dr = buf[i] - sr
    const dg = buf[i + 1] - sg
    const db = buf[i + 2] - sb
    const da = buf[i + 3] - sa
    return dr * dr + dg * dg + db * db + da * da <= tol2
  }
  const visited = new Uint8Array(w * h)
  const stack: number[] = [sy * w + sx]
  visited[sy * w + sx] = 1
  let cleared = 0
  while (stack.length) {
    const p = stack.pop()!
    const i = p * 4
    if (!match(i)) continue
    buf[i + 3] = 0
    cleared++
    const x = p % w
    const y = (p / w) | 0
    for (const [nx, ny] of [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ]) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
      const np = ny * w + nx
      if (!visited[np]) {
        visited[np] = 1
        stack.push(np)
      }
    }
  }
  return cleared
}

export function jsEngine(): InkEngine {
  const strokes = new Map<number, Stroke>()
  let nextId = 1
  log.info('JS fallback engine active')
  return {
    begin: (tool, size = 1, stab = -1) => {
      const id = nextId++
      strokes.set(id, newStroke(tool, size, stab))
      log.debug('begin', { id, tool, size, stab })
      return id
    },
    addPoint: (id, x, y, t, p) => {
      const s = strokes.get(id)
      if (!s) {
        log.debug('addPoint for unknown stroke', id)
        return []
      }
      const pt = { x, y, t, p }
      s.pts.push(pt)
      const out: Sample[] = []
      feed(s, pt, false, out)
      return out
    },
    predict: (id, x, y, t, p) => {
      const s = strokes.get(id)
      if (!s) return []
      const c: Stroke = { ...s, prev: { ...s.prev }, buf: s.buf.map((e) => ({ ...e })) }
      const out: Sample[] = []
      feed(c, { x, y, t, p }, false, out)
      return out
    },
    end: (id) => {
      const s = strokes.get(id)
      if (!s) {
        log.debug('end for unknown stroke', id)
        return []
      }
      const out = flush(s)
      strokes.delete(id)
      log.debug('end', { id, samples: out.length })
      return out
    },
    tail: (id) => {
      const s = strokes.get(id)
      if (!s) return []
      const c: Stroke = { ...s, prev: { ...s.prev }, buf: s.buf.map((e) => ({ ...e })) }
      return flush(c)
    },
    floodFill: pxFloodFill,
    boxBlur: pxBoxBlur,
    sharpen: pxSharpen,
    adjust: pxAdjust,
    wetStroke: pxWetStroke,
    inverseFill: pxInverseFill,
    eraseColor: pxEraseColor,
  }
}

let enginePromise: Promise<InkEngine> | null = null

export function initInk(): Promise<InkEngine> {
  if (!enginePromise) {
    enginePromise = (async () => {
      try {
        if (!window.Go) throw new Error('wasm_exec.js not loaded')
        const go = new window.Go()
        const result = await WebAssembly.instantiateStreaming(
          fetch('/engine.wasm'),
          go.importObject,
        )
        void go.run(result.instance)
        if (!window.Ink) throw new Error('Ink global missing after wasm init')
        log.info('wasm engine loaded')
        return window.Ink as InkEngine
      } catch (err) {
        log.warn('wasm engine unavailable, using JS fallback:', err)
        return jsEngine()
      }
    })()
  }
  return enginePromise
}
