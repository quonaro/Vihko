import type { InkEngine, Sample } from '../types'

declare global {
  interface Window {
    Go?: new () => {
      importObject: WebAssembly.Imports
      run(instance: WebAssembly.Instance): Promise<void>
    }
    Ink?: {
      begin(tool: string): number
      addPoint(id: number, x: number, y: number, t: number, p: number): Sample[]
      end(id: number): Sample[]
    }
  }
}

// Pure-JS fallback mirroring engine/main.go so the app still works if the
// wasm binary fails to load. Exported for tests (initInk() also falls back
// to it whenever the wasm binary is unavailable).
export function jsEngine(): InkEngine {
  interface Pt { x: number; y: number; t: number }
  interface S {
    tool: string
    pts: Pt[]
    seg: number
    smW: number
  }
  const strokes = new Map<number, S>()
  let nextId = 1

  const profile = (tool: string): [number, number, number, number, number] => {
    switch (tool) {
      case 'draw': return [1.6, 8.0, 0.9, 10.0, 0.92]
      case 'write': return [2.2, 0, 2.2, 2.2, 1.0]
      case 'shapes': return [2.2, 0, 2.2, 2.2, 1.0]
      case 'outline': return [6.5, 2.5, 5.0, 10.5, 0.95]
      case 'sketch': return [2.4, 3.5, 1.0, 6.5, 0.6]
      case 'color': return [12.0, 24.0, 8.0, 46.0, 0.045]
      case 'eraser': return [13.0, 5.0, 9.0, 26.0, 1.0]
      default: return [2.5, 0, 2.5, 2.5, 1]
    }
  }
  const targetW = (tool: string, v: number) => {
    const [b, g, mn, mx] = profile(tool)
    const k = 1 - Math.exp(-v / 0.55)
    let t = tool === 'color' ? b + g * (1 - k) : b + g * k
    return Math.min(mx, Math.max(mn, t))
  }
  const cr = (a: number, b: number, c: number, d: number, t: number) => {
    const t2 = t * t, t3 = t2 * t
    return 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (3 * b - a - 3 * c + d) * t3)
  }
  const emit = (s: S, i: number, out: Sample[]) => {
    const n = s.pts.length
    const p0 = s.pts[Math.max(0, i - 1)]
    const p1 = s.pts[i]
    const p2 = s.pts[Math.min(n - 1, i + 1)]
    const p3 = s.pts[Math.min(n - 1, i + 2)]
    const dt = Math.max(p2.t - p1.t, 1)
    const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y)
    const tw = targetW(s.tool, dist / dt)
    s.smW = s.smW === 0 ? tw : s.smW + (tw - s.smW) * 0.35
    const a = profile(s.tool)[4]
    const steps = dist > 40 ? 10 : 6
    for (let k = 1; k <= steps; k++) {
      const t = k / steps
      out.push({ x: cr(p0.x, p1.x, p2.x, p3.x, t), y: cr(p0.y, p1.y, p2.y, p3.y, t), w: s.smW, a })
    }
  }
  const drain = (s: S, flush: boolean): Sample[] => {
    const out: Sample[] = []
    const n = s.pts.length
    const limit = flush ? n - 1 : n - 2
    for (let i = s.seg + 1; i <= limit && i < n; i++) {
      if (i >= 0) { emit(s, i, out); s.seg = i }
    }
    return out
  }
  return {
    begin: (tool) => { const id = nextId++; strokes.set(id, { tool, pts: [], seg: -1, smW: 0 }); return id },
    addPoint: (id, x, y, t) => { const s = strokes.get(id); if (!s) return []; s.pts.push({ x, y, t }); return drain(s, false) },
    end: (id) => { const s = strokes.get(id); if (!s) return []; const out = drain(s, true); strokes.delete(id); return out },
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
        return window.Ink as InkEngine
      } catch (err) {
        console.warn('[ink] wasm engine unavailable, using JS fallback:', err)
        return jsEngine()
      }
    })()
  }
  return enginePromise
}
