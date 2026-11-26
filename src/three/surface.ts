import type * as THREE from 'three'
import type { Quality } from '../quality'

// A WebGL surface per scene kind — the canvas AND its renderer outlive the
// view that shows them. Building a fresh WebGLRenderer on every mount used to
// cost a new GL context, a full shader-program compile and a re-baked studio
// environment map on each shelf↔journal switch, which is the 1–2 s blank
// stage users waited through. Views append `surface.canvas` into their own
// stage box and release it on unmount; the next mount reuses the warm
// context, its compiled programs and its IBL texture.
//
// Deliberately free of a static three import: the views import this module
// eagerly, three.js must stay in its own lazy chunk.

export type SurfaceKind = 'shelf' | 'journal'

export interface Surface {
  kind: SurfaceKind
  quality: Quality
  canvas: HTMLCanvasElement
  renderer: THREE.WebGLRenderer
}

type SurfaceFactory = (canvas: HTMLCanvasElement, quality: Quality) => Promise<THREE.WebGLRenderer>

const defaultFactory: SurfaceFactory = async (canvas, quality) => {
  const { createRenderer } = await import('./stage')
  return createRenderer(canvas, quality)
}

let factory: SurfaceFactory = defaultFactory
const cache = new Map<SurfaceKind, Surface>()

// Injectable so the lifecycle is unit-testable without a WebGL context.
export function setSurfaceFactory(next: SurfaceFactory | null) {
  factory = next ?? defaultFactory
}

// The canvas is sized by its host box; the scene's ResizeObserver does the
// renderer-side resizing, so only the box contract lives here.
const CANVAS_STYLE = {
  display: 'block',
  width: '100%',
  height: '100%',
  touchAction: 'none',
} satisfies Partial<CSSStyleDeclaration>

async function make(kind: SurfaceKind, quality: Quality): Promise<Surface> {
  const canvas = document.createElement('canvas')
  canvas.className = 'three-surface'
  Object.assign(canvas.style, CANVAS_STYLE)
  const renderer = await factory(canvas, quality)
  const surface: Surface = { kind, quality, canvas, renderer }
  // A lost context can never render again — drop it so the next mount builds
  // a fresh one instead of handing out a dead renderer.
  canvas.addEventListener('webglcontextlost', () => {
    if (cache.get(kind) === surface) cache.delete(kind)
  })
  return surface
}

// Acquisitions are serialized per kind: two mounts racing (a quality change
// while the previous scene is still starting) must not build contexts in
// parallel and retire each other's surface.
const queues = new Map<SurfaceKind, Promise<void>>()

function enqueue<T>(kind: SurfaceKind, job: () => Promise<T>): Promise<T> {
  const prev = queues.get(kind) ?? Promise.resolve()
  const run = prev.then(job, job)
  queues.set(
    kind,
    run.then(
      () => undefined,
      () => undefined,
    ),
  )
  return run
}

async function acquireNow(kind: SurfaceKind, quality: Quality): Promise<Surface> {
  const hit = cache.get(kind)
  if (hit && hit.quality === quality) return hit
  if (hit) disposeSurface(hit)
  const surface = await make(kind, quality)
  cache.set(kind, surface)
  return surface
}

// The cached surface for `kind` at `quality`; a quality change retires the
// old renderer (its shadow-map size, DPR cap and VSM path are fixed at
// construction — they can't be patched on a live one).
export function acquireSurface(kind: SurfaceKind, quality: Quality): Promise<Surface> {
  return enqueue(kind, () => acquireNow(kind, quality))
}

// Hand the canvas back after the scene is disposed. The renderer keeps its
// programs and environment; only the per-scene objects are gone.
export function releaseSurface(surface: Surface) {
  surface.canvas.remove()
  surface.renderer.setRenderTarget(null)
  surface.renderer.setScissorTest(false)
  surface.renderer.clear()
}

export function disposeSurface(surface: Surface) {
  if (cache.get(surface.kind) === surface) cache.delete(surface.kind)
  surface.canvas.remove()
  surface.renderer.dispose()
}

// Test hook: forget every cached surface (also useful on a hard quality reset).
export function disposeAllSurfaces() {
  for (const surface of [...cache.values()]) disposeSurface(surface)
}
