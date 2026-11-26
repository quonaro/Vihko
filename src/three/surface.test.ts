import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type * as THREE from 'three'
import type { Quality } from '../quality'
import { acquireSurface, disposeAllSurfaces, releaseSurface, setSurfaceFactory } from './surface'

class FakeRenderer {
  disposed = false
  renderTarget: unknown = 'scene'
  scissorTest = true
  clears = 0
  setRenderTarget(target: unknown) {
    this.renderTarget = target
  }
  setScissorTest(on: boolean) {
    this.scissorTest = on
  }
  clear() {
    this.clears++
  }
  dispose() {
    this.disposed = true
  }
}

let created: FakeRenderer[] = []

beforeEach(() => {
  created = []
  setSurfaceFactory(async () => {
    const renderer = new FakeRenderer()
    created.push(renderer)
    return renderer as unknown as THREE.WebGLRenderer
  })
})

afterEach(() => {
  disposeAllSurfaces()
  setSurfaceFactory(null)
})

describe('acquireSurface', () => {
  it('reuses the canvas, context and quality for repeated acquires', async () => {
    const first = await acquireSurface('journal', 'medium')
    const second = await acquireSurface('journal', 'medium')
    expect(second).toBe(first)
    expect(created).toHaveLength(1)
  })

  it('keeps shelf and journal on separate surfaces', async () => {
    const shelf = await acquireSurface('shelf', 'medium')
    const journal = await acquireSurface('journal', 'medium')
    expect(journal.canvas).not.toBe(shelf.canvas)
    expect(created).toHaveLength(2)
  })

  it('retires the renderer when the quality tier changes', async () => {
    const first = await acquireSurface('shelf', 'medium')
    const next = await acquireSurface('shelf', 'low')
    expect(next.canvas).not.toBe(first.canvas)
    expect(created[0].disposed).toBe(true)
    expect(created).toHaveLength(2)
  })

  it('stays warm across a release, so the next mount skips the rebuild', async () => {
    const surface = await acquireSurface('shelf', 'medium')
    document.body.appendChild(surface.canvas)

    releaseSurface(surface)
    expect(surface.canvas.isConnected).toBe(false)

    const again = await acquireSurface('shelf', 'medium')
    expect(again).toBe(surface)
    expect(created).toHaveLength(1)
  })

  it('returns the renderer to a neutral target state on release', async () => {
    const surface = await acquireSurface('shelf', 'medium')
    const renderer = created[0]
    releaseSurface(surface)
    expect(renderer.renderTarget).toBe(null)
    expect(renderer.scissorTest).toBe(false)
    expect(renderer.clears).toBe(1)
  })

  it('serializes a quality change racing the previous mount', async () => {
    const first = acquireSurface('shelf', 'medium')
    const second = acquireSurface('shelf', 'low')
    const [oldSurface, current] = await Promise.all([first, second])

    expect(created).toHaveLength(2)
    expect(created[0].disposed).toBe(true)
    expect(oldSurface.quality).toBe('medium')
    expect(current.quality).toBe('low')
    // The loser is not left in the cache: the live surface is the low tier.
    expect(await acquireSurface('shelf', 'low')).toBe(current)
  })

  it('rebuilds after the context is lost', async () => {
    const surface = await acquireSurface('journal', 'medium')
    surface.canvas.dispatchEvent(new Event('webglcontextlost'))

    const rebuilt = await acquireSurface('journal' as const, 'medium' as Quality)
    expect(rebuilt).not.toBe(surface)
    expect(created).toHaveLength(2)
  })
})
