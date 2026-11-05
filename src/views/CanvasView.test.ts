import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import CanvasView from './CanvasView.vue'
import { i18n } from '../i18n'
import { store, currentPage, pageLayers, addLayer, updateLayer, pageRev } from '../store'
import { PAGE_W, PAGE_H } from '../pageSpace'
import type { Journal } from '../types'

// jsdom can't decode images — the import pipeline is stubbed; the layer and
// tool behavior around it is what these tests exercise.
vi.mock('../ink/ops', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../ink/ops')>()
  return {
    ...mod,
    imageFileToPhoto: vi.fn(async () => ({
      src: 'data:image/png;base64,AAAA',
      w: 200,
      h: 120,
    })),
  }
})

const mountCanvas = async () => {
  const w = mount(CanvasView, { global: { plugins: [i18n] }, attachTo: document.body })
  await flushPromises() // onMounted awaits initInk()
  Object.defineProperty(w.find('canvas').element, 'clientWidth', { value: 800, configurable: true })
  return w
}

const mountSized = async (cw: number, ch: number) => {
  const w = await mountCanvas()
  const el = w.find('canvas').element
  Object.defineProperty(el, 'clientWidth', { value: cw, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: ch, configurable: true })
  window.dispatchEvent(new Event('resize'))
  return w
}

const initialScale = (w: number, h: number) => Math.min(w / PAGE_W, h / PAGE_H) * 0.8

// The canvas's own setup exposes the raw view state (s/ox/oy/angle).
const viewAngle = (w: ReturnType<typeof mount>) =>
  (w.vm as unknown as { view: { angle: number } }).view.angle

const tap = (canvas: Element, x: number, y: number) => {
  canvas.dispatchEvent(
    pev('pointerdown', {
      pointerId: 1,
      pointerType: 'mouse',
      clientX: x,
      clientY: y,
      timeStamp: 0,
      pressure: 0.5,
    }),
  )
  canvas.dispatchEvent(
    pev('pointerup', {
      pointerId: 1,
      pointerType: 'mouse',
      clientX: x,
      clientY: y,
      timeStamp: 8,
    }),
  )
}

const pinch = (
  canvas: Element,
  startA: [number, number],
  startB: [number, number],
  endA: [number, number],
  endB: [number, number],
) => {
  const pointer = (type: string, id: number, [x, y]: [number, number], timeStamp: number) =>
    canvas.dispatchEvent(
      pev(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, timeStamp }),
    )
  pointer('pointerdown', 1, startA, 0)
  pointer('pointerdown', 2, startB, 1)
  pointer('pointermove', 1, endA, 16)
  pointer('pointermove', 2, endB, 20)
  pointer('pointerup', 1, endA, 24)
  pointer('pointerup', 2, endB, 25)
}

function pev(type: string, props: Record<string, unknown> = {}) {
  const e = new Event(type, { bubbles: true })
  for (const [k, v] of Object.entries(props)) {
    Object.defineProperty(e, k, { value: v, configurable: true })
  }
  return e
}

// jsdom has no canvas backend — hand each created canvas a stubbed 2d
// context so paint/replay code paths run for real and we can observe them.
const mockCanvasBackend = () => {
  const stub2d = () =>
    ({
      save: vi.fn(),
      restore: vi.fn(),
      setTransform: vi.fn(),
      beginPath: vi.fn(),
      rect: vi.fn(),
      clip: vi.fn(),
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      closePath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      scale: vi.fn(),
      setLineDash: vi.fn(),
      drawImage: vi.fn(),
      createRadialGradient: () => ({ addColorStop: vi.fn() }),
      createLinearGradient: () => ({ addColorStop: vi.fn() }),
      globalAlpha: 1,
      globalCompositeOperation: 'source-over',
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
    }) as unknown as CanvasRenderingContext2D
  const realCreate = document.createElement.bind(document)
  const canvases: HTMLCanvasElement[] = []
  const ctxs = new Map<HTMLCanvasElement, CanvasRenderingContext2D>()
  const spy = vi.spyOn(document, 'createElement').mockImplementation(((
    tag: string,
    ...rest: unknown[]
  ) => {
    const el = realCreate(tag as 'canvas', ...(rest as never[]))
    if (tag === 'canvas') {
      const stub = stub2d()
      canvases.push(el as HTMLCanvasElement)
      ctxs.set(el as HTMLCanvasElement, stub)
      Object.defineProperty(el, 'getContext', { value: () => stub, configurable: true })
    }
    return el
  }) as typeof document.createElement)
  return { canvases, ctxs, restore: () => spy.mockRestore() }
}

const journal = (): Journal => ({
  id: 'j1',
  title: 'Field Notes',
  cover: 0,
  createdAt: 0,
  pages: [
    { id: 'p1', strokes: [], createdAt: 0 },
    { id: 'p2', strokes: [], createdAt: 0 },
  ],
})

beforeEach(() => {
  store.journals.splice(0, store.journals.length, journal())
  store.journalId = 'j1'
  store.pageId = 'p1'
  store.view = 'canvas'
  store.tool = 'write'
  store.spreadMode = 'full'
  localStorage.clear()
})

describe('CanvasView', () => {
  it('shows the journal title and page index', async () => {
    const w = await mountCanvas()
    expect(w.find('.page-badge').text()).toContain('Field Notes')
    expect(w.find('.page-badge').text()).toContain('1/2')
    w.unmount()
  })

  it('close button leaves the canvas view', async () => {
    const w = await mountCanvas()
    await w.find('.close-btn').trigger('click')
    expect(store.view).toBe('journal')
    w.unmount()
  })

  it('does not show the PNG download button', async () => {
    const w = await mountCanvas()
    expect(w.find('button[title="Export PNG"]').exists()).toBe(false)
    w.unmount()
  })

  it('has no zoom buttons; zoom is gesture-only', async () => {
    const w = await mountCanvas()
    expect(w.find('.zoom-actions').exists()).toBe(false)
    expect(w.find(`button[title="${i18n.global.t('canvas.zoomIn')}"]`).exists()).toBe(false)
    expect(w.find(`button[title="${i18n.global.t('canvas.zoomOut')}"]`).exists()).toBe(false)
    expect(w.find(`button[title="${i18n.global.t('canvas.zoomFit')}"]`).exists()).toBe(false)
    w.unmount()
  })

  it('shows a brush-size ring under a hovering mouse on ink tools only', async () => {
    const w = await mountSized(800, 600)
    const canvas = w.find('canvas')
    const move = (x: number, y: number, pointerType = 'mouse') =>
      canvas.element.dispatchEvent(
        pev('pointermove', { pointerId: 9, pointerType, clientX: x, clientY: y }),
      )

    move(100, 120)
    await w.vm.$nextTick()
    const ring = w.find('.brush-ring')
    expect(ring.exists()).toBe(true)
    // 'write' max footprint is 4.4*(1+0.1) page units at size 1, scaled.
    const dia = 4.4 * 1.1 * initialScale(800, 600)
    expect(ring.attributes('style')).toContain(`width: ${dia}px`)
    expect(ring.attributes('style')).toContain('left: 100px')
    expect(ring.attributes('style')).toContain('top: 120px')
    expect(canvas.element.style.cursor).toBe('none')

    // Non-ink tools hide the ring and restore the cursor.
    store.tool = 'fill'
    move(150, 150)
    await w.vm.$nextTick()
    expect(w.find('.brush-ring').exists()).toBe(false)
    expect(canvas.element.style.cursor).toBe('default')

    // Leaving the canvas drops the tracked position; a touch move then
    // shows nothing — fingers have no hover.
    canvas.element.dispatchEvent(pev('pointerleave', { pointerId: 9, pointerType: 'mouse' }))
    store.tool = 'write'
    move(200, 200, 'touch')
    await w.vm.$nextTick()
    expect(w.find('.brush-ring').exists()).toBe(false)

    // A later mouse move brings the ring back at the new position.
    move(220, 220)
    await w.vm.$nextTick()
    expect(w.find('.brush-ring').exists()).toBe(true)
    w.unmount()
  })

  it('two-finger rotation turns the sheet and drawing follows the rotated view', async () => {
    const w = await mountSized(400, 800)
    const canvas = w.find('canvas').element as HTMLCanvasElement
    expect(w.find('.viewport').exists()).toBe(true)

    pinch(canvas, [300, 400], [200, 400], [250, 450], [250, 350])
    // Rotation is applied inside the canvas transform, not on the element.
    expect(canvas.style.transform).toBe('')
    expect(viewAngle(w)).toBeCloseTo(Math.PI / 2)

    // The page point under the gesture midpoint stays under it: after the
    // 90deg turn the raw midpoint (250,400) is local (200,350).
    const scale = initialScale(400, 800)
    const midPage = {
      x: (250 - (400 - PAGE_W * scale) / 2) / scale,
      y: (400 - (800 - PAGE_H * scale) / 2) / scale,
    }
    const ox = 200 - midPage.x * scale
    const oy = 350 - midPage.y * scale
    tap(canvas, 300, 400)
    const point = currentPage()!.strokes[0].pts[0]
    // tap at raw (300,400) -> local (200,300) at angle 90
    expect(point.x).toBeCloseTo((200 - ox) / scale, 1)
    expect(point.y).toBeCloseTo((300 - oy) / scale, 1)
    w.unmount()
  })

  it('opens with the whole sheet visible and centered', async () => {
    const w = await mountSized(400, 800)
    const canvas = w.find('canvas').element
    tap(canvas, 50, 400)
    tap(canvas, 350, 400)
    const [left, right] = currentPage()!.strokes.map((stroke) => stroke.pts[0])

    expect(left.x).toBeGreaterThan(0)
    expect(right.x).toBeLessThan(PAGE_W)
    expect(left.y).toBeCloseTo(PAGE_H / 2, 0)
    expect(right.y).toBeCloseTo(PAGE_H / 2, 0)
    w.unmount()
  })

  it('spread focus cycles the working half and reframes the viewport', async () => {
    const w = await mountSized(400, 800)
    const btn = w.find('.spread-btn')
    expect(btn.exists()).toBe(true)
    const canvas = w.find('canvas').element

    await btn.trigger('click')
    expect(store.spreadMode).toBe('left')
    tap(canvas, 200, 400) // canvas center -> left half's center
    let point = currentPage()!.strokes[0].pts[0]
    expect(point.x).toBeCloseTo(PAGE_W / 4, 0)
    expect(point.y).toBeCloseTo(PAGE_H / 2, 0)

    await btn.trigger('click')
    expect(store.spreadMode).toBe('right')
    tap(canvas, 200, 400)
    point = currentPage()!.strokes[1].pts[0]
    expect(point.x).toBeCloseTo((PAGE_W * 3) / 4, 0)
    expect(point.y).toBeCloseTo(PAGE_H / 2, 0)

    await btn.trigger('click')
    expect(store.spreadMode).toBe('full')
    w.unmount()
  })

  it('hides the spread button on non-landscape pages', async () => {
    const w = await mountCanvas()
    expect(w.find('.spread-btn').exists()).toBe(true)
    currentPage()!.w = PAGE_W / 2 // portrait page
    await w.vm.$nextTick()
    expect(w.find('.spread-btn').exists()).toBe(false)
    w.unmount()
  })

  it('splits a stroke at the fold — the eraser cannot touch the hidden half', async () => {
    const w = await mountSized(400, 800)
    await w.find('.spread-btn').trigger('click') // left half
    store.tool = 'eraser'
    const canvas = w.find('canvas').element
    // In left mode on 400x800 the fold lands near canvas x≈360: a drag from
    // 200 to 390 crosses it.
    canvas.dispatchEvent(
      pev('pointerdown', {
        pointerId: 1,
        pointerType: 'mouse',
        clientX: 200,
        clientY: 400,
        timeStamp: 0,
      }),
    )
    canvas.dispatchEvent(
      pev('pointermove', {
        pointerId: 1,
        pointerType: 'mouse',
        clientX: 250,
        clientY: 400,
        timeStamp: 8,
      }),
    )
    canvas.dispatchEvent(
      pev('pointermove', {
        pointerId: 1,
        pointerType: 'mouse',
        clientX: 390,
        clientY: 400,
        timeStamp: 16,
      }),
    )
    expect(currentPage()!.strokes).toHaveLength(1) // committed at the fold
    // Re-entering the half resumes as a new stroke.
    canvas.dispatchEvent(
      pev('pointermove', {
        pointerId: 1,
        pointerType: 'mouse',
        clientX: 300,
        clientY: 400,
        timeStamp: 24,
      }),
    )
    canvas.dispatchEvent(
      pev('pointerup', {
        pointerId: 1,
        pointerType: 'mouse',
        clientX: 300,
        clientY: 400,
        timeStamp: 32,
      }),
    )
    const strokes = currentPage()!.strokes
    expect(strokes).toHaveLength(2)
    for (const stroke of strokes)
      for (const pt of stroke.pts) expect(pt.x).toBeLessThanOrEqual(PAGE_W / 2 + 0.01)
    w.unmount()
  })

  it('keeps a stroke started outside the focused half from ever painting', async () => {
    const w = await mountSized(400, 800)
    await w.find('.spread-btn').trigger('click') // left half
    store.tool = 'write'
    const canvas = w.find('canvas').element
    // x=390 lands on the hidden right half.
    canvas.dispatchEvent(
      pev('pointerdown', {
        pointerId: 1,
        pointerType: 'mouse',
        clientX: 390,
        clientY: 400,
        timeStamp: 0,
      }),
    )
    canvas.dispatchEvent(
      pev('pointermove', {
        pointerId: 1,
        pointerType: 'mouse',
        clientX: 385,
        clientY: 400,
        timeStamp: 8,
      }),
    )
    canvas.dispatchEvent(
      pev('pointerup', {
        pointerId: 1,
        pointerType: 'mouse',
        clientX: 385,
        clientY: 400,
        timeStamp: 16,
      }),
    )
    expect(currentPage()!.strokes).toHaveLength(0)
    w.unmount()
  })

  it('clamps a shape drag to the focused half', async () => {
    const w = await mountSized(400, 800)
    await w.find('.spread-btn').trigger('click') // left half
    store.tool = 'shapes'
    store.shape = 'rectangle'
    const canvas = w.find('canvas').element
    canvas.dispatchEvent(
      pev('pointerdown', {
        pointerId: 1,
        pointerType: 'mouse',
        clientX: 200,
        clientY: 300,
        timeStamp: 0,
      }),
    )
    canvas.dispatchEvent(
      pev('pointermove', {
        pointerId: 1,
        pointerType: 'mouse',
        clientX: 390,
        clientY: 500,
        timeStamp: 16,
      }),
    )
    canvas.dispatchEvent(
      pev('pointerup', {
        pointerId: 1,
        pointerType: 'mouse',
        clientX: 390,
        clientY: 500,
        timeStamp: 24,
      }),
    )
    const stroke = currentPage()!.strokes[0]
    expect(stroke.tool).toBe('shapes')
    for (const pt of stroke.pts) expect(pt.x).toBeLessThanOrEqual(PAGE_W / 2 + 0.01)
    w.unmount()
  })

  it('records the fold clip on strokes committed in a focused half', async () => {
    const w = await mountSized(400, 800)
    store.tool = 'write'
    tap(w.find('canvas').element, 200, 400)
    expect(currentPage()!.strokes[0].clip).toBeUndefined() // full spread — no clip

    await w.find('.spread-btn').trigger('click') // left half
    tap(w.find('canvas').element, 200, 400)
    const stroke = currentPage()!.strokes[1]
    expect(stroke.clip).toHaveLength(4)
    const xs = stroke.clip!.map((p) => p.x)
    expect(Math.min(...xs)).toBeCloseTo(0, 1)
    expect(Math.max(...xs)).toBeCloseTo(PAGE_W / 2, 0)
    w.unmount()
  })

  it('confines committed fills to the focused spread half', async () => {
    const w = await mountSized(400, 800)
    store.tool = 'fill'
    const canvas = w.find('canvas').element
    const btn = w.find('.spread-btn')
    const opRect = (i: number) => (currentPage()!.ops![i] as { rect?: object }).rect

    tap(canvas, 200, 400) // full spread — unconfined
    expect(currentPage()!.ops![0].kind).toBe('fill')
    expect(opRect(0)).toBeUndefined()

    await btn.trigger('click') // left half
    tap(canvas, 200, 400)
    expect(opRect(1)).toEqual({ x: 0, y: 0, w: PAGE_W / 2, h: PAGE_H })

    await btn.trigger('click') // right half
    tap(canvas, 200, 400)
    expect(opRect(2)).toEqual({ x: PAGE_W / 2, y: 0, w: PAGE_W / 2, h: PAGE_H })
    w.unmount()
  })

  it('a pen drag commits a stroke into the store', async () => {
    const w = await mountCanvas()
    const canvas = w.find('canvas').element
    canvas.dispatchEvent(
      pev('pointerdown', {
        pointerId: 1,
        pointerType: 'mouse',
        clientX: 100,
        clientY: 100,
        timeStamp: 0,
        pressure: 0.5,
      }),
    )
    canvas.dispatchEvent(
      pev('pointermove', {
        pointerId: 1,
        pointerType: 'mouse',
        clientX: 140,
        clientY: 120,
        timeStamp: 16,
        pressure: 0.5,
      }),
    )
    canvas.dispatchEvent(
      pev('pointermove', {
        pointerId: 1,
        pointerType: 'mouse',
        clientX: 180,
        clientY: 140,
        timeStamp: 32,
        pressure: 0.5,
      }),
    )
    canvas.dispatchEvent(
      pev('pointerup', {
        pointerId: 1,
        pointerType: 'mouse',
        clientX: 180,
        clientY: 140,
        timeStamp: 40,
      }),
    )
    const strokes = currentPage()!.strokes
    expect(strokes).toHaveLength(1)
    expect(strokes[0].tool).toBe('write')
    expect(strokes[0].pts.length).toBeGreaterThanOrEqual(2)
    w.unmount()
  })

  it('dragging with the shape tool commits the selected geometric shape', async () => {
    const w = await mountCanvas()
    store.tool = 'shapes'
    store.shape = 'rectangle'
    const canvas = w.find('canvas').element
    canvas.dispatchEvent(
      pev('pointerdown', {
        pointerId: 1,
        pointerType: 'mouse',
        clientX: 100,
        clientY: 100,
        timeStamp: 0,
        pressure: 0.5,
      }),
    )
    canvas.dispatchEvent(
      pev('pointermove', {
        pointerId: 1,
        pointerType: 'mouse',
        clientX: 170,
        clientY: 150,
        timeStamp: 16,
        pressure: 0.5,
      }),
    )
    canvas.dispatchEvent(
      pev('pointerup', {
        pointerId: 1,
        pointerType: 'mouse',
        clientX: 170,
        clientY: 150,
        timeStamp: 24,
        pressure: 0.5,
      }),
    )

    const strokes = currentPage()!.strokes
    expect(strokes).toHaveLength(1)
    expect(strokes[0].tool).toBe('shapes')
    expect(strokes[0].pts.length).toBe(5)
    expect(strokes[0].pts[0]).toMatchObject({ x: strokes[0].pts[4].x, y: strokes[0].pts[4].y })
    w.unmount()
  })

  it('commits a drawn shape onto a new layer and activates the transform tool', async () => {
    const w = await mountSized(400, 800)
    store.tool = 'shapes'
    store.shape = 'rectangle'
    const baseLayerId = pageLayers()[0].id
    const canvas = w.find('canvas').element
    canvas.dispatchEvent(
      pev('pointerdown', {
        pointerId: 1,
        pointerType: 'mouse',
        clientX: 100,
        clientY: 100,
        timeStamp: 0,
        pressure: 0.5,
      }),
    )
    canvas.dispatchEvent(
      pev('pointermove', {
        pointerId: 1,
        pointerType: 'mouse',
        clientX: 170,
        clientY: 150,
        timeStamp: 16,
        pressure: 0.5,
      }),
    )
    canvas.dispatchEvent(
      pev('pointerup', {
        pointerId: 1,
        pointerType: 'mouse',
        clientX: 170,
        clientY: 150,
        timeStamp: 24,
        pressure: 0.5,
      }),
    )

    const layers = pageLayers()
    expect(layers).toHaveLength(2)
    const stroke = currentPage()!.strokes[0]
    expect(stroke.tool).toBe('shapes')
    expect(stroke.layerId).toBe(layers[1].id)
    expect(stroke.layerId).not.toBe(baseLayerId)
    expect(currentPage()!.activeLayerId).toBe(layers[1].id)
    expect(store.tool).toBe('transform')
    w.unmount()
  })

  it('does not create a layer for a shape tap that never drags', async () => {
    const w = await mountSized(400, 800)
    store.tool = 'shapes'
    store.shape = 'rectangle'
    tap(w.find('canvas').element, 200, 300)
    expect(currentPage()!.strokes).toHaveLength(0)
    expect(pageLayers()).toHaveLength(1)
    expect(store.tool).toBe('shapes')
    w.unmount()
  })

  it('imports a photo onto a new layer and activates the transform tool', async () => {
    const w = await mountCanvas()
    const baseLayerId = pageLayers()[0].id
    const input = w.find('input[type="file"]').element as HTMLInputElement
    const file = new File(['x'], 'photo.png', { type: 'image/png' })
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    input.dispatchEvent(new Event('change'))
    await flushPromises()

    const layers = pageLayers()
    expect(layers).toHaveLength(2)
    const op = currentPage()!.ops![currentPage()!.ops!.length - 1]
    expect(op.kind).toBe('photo')
    expect(op.layerId).toBe(layers[1].id)
    expect(op.layerId).not.toBe(baseLayerId)
    expect(currentPage()!.activeLayerId).toBe(layers[1].id)
    expect(store.tool).toBe('transform')
    w.unmount()
  })

  it('stores the selected brush-size multiplier with the stroke', async () => {
    const w = await mountCanvas()
    store.tool = 'write'
    const slider = w.find('.brush-slider')
    expect(w.find('.brush-control').attributes('style')).toContain('10px')
    expect(w.find('.brush-thumb').attributes('style')).toContain('width: 10px')
    expect(w.find('.brush-thumb').attributes('style')).toContain('height: 10px')
    await slider.setValue('2.25')
    expect(w.find('.brush-control').attributes('style')).toContain('13.75px')
    expect(w.find('.brush-thumb').attributes('style')).toContain('width: 13.75px')
    expect(w.find('.brush-thumb').attributes('style')).toContain('height: 13.75px')
    tap(w.find('canvas').element, 120, 130)
    expect(currentPage()!.strokes[0].size).toBe(2.25)
    w.unmount()
  })

  it('pinch zooms and pans around the moving two-finger midpoint', async () => {
    const w = await mountSized(400, 800)
    const canvas = w.find('canvas').element
    pinch(canvas, [100, 350], [200, 350], [100, 350], [300, 370])
    await w.vm.$nextTick()
    tap(canvas, 50, 400)
    expect(currentPage()!.strokes).toHaveLength(1)
    w.unmount()
  })

  it('the transform tool drags only the active layer in page coordinates', async () => {
    const w = await mountSized(400, 800)
    const layer = addLayer()!
    const canvas = w.find('canvas').element
    tap(canvas, 200, 400) // content on the new layer — empty layers can't be transformed
    const revision = pageRev(currentPage()!)
    store.tool = 'transform'
    canvas.dispatchEvent(
      pev('pointerdown', {
        pointerId: 1,
        pointerType: 'touch',
        clientX: 100,
        clientY: 300,
        timeStamp: 0,
      }),
    )
    canvas.dispatchEvent(
      pev('pointermove', {
        pointerId: 1,
        pointerType: 'touch',
        clientX: 140,
        clientY: 330,
        timeStamp: 16,
      }),
    )
    expect(pageLayers().find((item) => item.id === layer.id)?.x).toBe(0)
    expect(pageRev(currentPage()!)).toBe(revision)
    canvas.dispatchEvent(
      pev('pointerup', {
        pointerId: 1,
        pointerType: 'touch',
        clientX: 140,
        clientY: 330,
        timeStamp: 24,
      }),
    )
    expect(pageLayers().find((item) => item.id === layer.id)?.x).toBeCloseTo(
      40 / initialScale(400, 800),
    )
    expect(pageLayers()[0].x).toBe(0)
    expect(pageRev(currentPage()!)).toBeGreaterThan(revision)
    w.unmount()
  })

  it('coalesces transform updates to one frame and commits the final pointer position', async () => {
    const w = await mountSized(400, 800)
    const layer = addLayer()!
    const canvas = w.find('canvas').element
    tap(canvas, 200, 400)
    store.tool = 'transform'
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame')
    canvas.dispatchEvent(
      pev('pointerdown', {
        pointerId: 1,
        pointerType: 'touch',
        clientX: 100,
        clientY: 300,
        timeStamp: 0,
      }),
    )
    for (const [x, timeStamp] of [
      [120, 8],
      [140, 16],
      [160, 24],
    ] as const) {
      canvas.dispatchEvent(
        pev('pointermove', {
          pointerId: 1,
          pointerType: 'touch',
          clientX: x,
          clientY: 300,
          timeStamp,
        }),
      )
    }

    expect(requestFrame).toHaveBeenCalledTimes(1)
    canvas.dispatchEvent(
      pev('pointerup', {
        pointerId: 1,
        pointerType: 'touch',
        clientX: 180,
        clientY: 300,
        timeStamp: 32,
      }),
    )

    expect(pageLayers().find((item) => item.id === layer.id)?.x).toBeCloseTo(
      80 / initialScale(400, 800),
    )
    requestFrame.mockRestore()
    w.unmount()
  })

  it('the transform tool does not move an empty layer', async () => {
    const w = await mountSized(400, 800)
    const layer = addLayer()!
    const revision = pageRev(currentPage()!)
    const canvas = w.find('canvas').element
    store.tool = 'transform'
    canvas.dispatchEvent(
      pev('pointerdown', {
        pointerId: 1,
        pointerType: 'touch',
        clientX: 100,
        clientY: 300,
        timeStamp: 0,
      }),
    )
    canvas.dispatchEvent(
      pev('pointermove', {
        pointerId: 1,
        pointerType: 'touch',
        clientX: 140,
        clientY: 330,
        timeStamp: 16,
      }),
    )
    canvas.dispatchEvent(
      pev('pointerup', {
        pointerId: 1,
        pointerType: 'touch',
        clientX: 140,
        clientY: 330,
        timeStamp: 24,
      }),
    )
    expect(pageLayers().find((item) => item.id === layer.id)?.x).toBe(0)
    expect(pageRev(currentPage()!)).toBe(revision)
    w.unmount()
  })

  it('draws under the pointer on a moved, scaled, and rotated layer', async () => {
    const w = await mountSized(400, 800)
    const layer = pageLayers()[0]
    updateLayer(layer.id, { x: 24, y: -18, scale: 1.4, rotation: 31 })
    const screen = { x: 210, y: 420 }
    const s = initialScale(400, 800)
    const ox = (400 - PAGE_W * s) / 2
    const oy = (800 - PAGE_H * s) / 2
    const expected = { x: (screen.x - ox) / s, y: (screen.y - oy) / s }

    tap(w.find('canvas').element, screen.x, screen.y)

    const point = currentPage()!.strokes[0].pts[0]
    const angle = (layer.rotation * Math.PI) / 180
    const dx = (point.x - PAGE_W / 2) * layer.scale
    const dy = (point.y - PAGE_H / 2) * layer.scale
    const painted = {
      x: PAGE_W / 2 + layer.x + dx * Math.cos(angle) - dy * Math.sin(angle),
      y: PAGE_H / 2 + layer.y + dx * Math.sin(angle) + dy * Math.cos(angle),
    }
    expect(painted.x).toBeCloseTo(expected.x)
    expect(painted.y).toBeCloseTo(expected.y)
    w.unmount()
  })

  it('resizes the active layer by dragging a corner handle', async () => {
    const w = await mountSized(400, 800)
    store.tool = 'write'
    const canvas = w.find('canvas').element
    tap(canvas, 200, 400)
    const point = currentPage()!.strokes[0].pts[0]
    const scale = initialScale(400, 800)
    const offsetX = (400 - PAGE_W * scale) / 2
    const offsetY = (800 - PAGE_H * scale) / 2
    const x = (point.x - 15) * scale + offsetX
    const y = (point.y - 15) * scale + offsetY

    store.tool = 'transform'
    canvas.dispatchEvent(
      pev('pointerdown', {
        pointerId: 1,
        pointerType: 'touch',
        clientX: x,
        clientY: y,
        timeStamp: 0,
      }),
    )
    canvas.dispatchEvent(
      pev('pointermove', {
        pointerId: 1,
        pointerType: 'touch',
        clientX: x - 20,
        clientY: y - 20,
        timeStamp: 16,
      }),
    )
    expect(pageLayers()[0].scale).toBe(1)
    canvas.dispatchEvent(
      pev('pointerup', {
        pointerId: 1,
        pointerType: 'touch',
        clientX: x - 20,
        clientY: y - 20,
        timeStamp: 24,
      }),
    )
    expect(pageLayers()[0].scale).toBeGreaterThan(1)
    w.unmount()
  })

  it('rotates the active layer from the frame rotation handle', async () => {
    const w = await mountSized(400, 800)
    store.tool = 'write'
    const canvas = w.find('canvas').element
    tap(canvas, 200, 400)
    store.tool = 'transform'
    const handleY = 400 - 15 * initialScale(400, 800) - 24
    canvas.dispatchEvent(
      pev('pointerdown', {
        pointerId: 1,
        pointerType: 'touch',
        clientX: 200,
        clientY: handleY,
        timeStamp: 0,
      }),
    )
    canvas.dispatchEvent(
      pev('pointermove', {
        pointerId: 1,
        pointerType: 'touch',
        clientX: 230,
        clientY: 400,
        timeStamp: 16,
      }),
    )
    expect(pageLayers()[0].rotation).toBe(0)
    canvas.dispatchEvent(
      pev('pointerup', {
        pointerId: 1,
        pointerType: 'touch',
        clientX: 230,
        clientY: 400,
        timeStamp: 24,
      }),
    )
    expect(pageLayers()[0].rotation).toBeCloseTo(90)
    w.unmount()
  })

  it('shows resize and rotation cursors when hovering transform handles', async () => {
    const w = await mountSized(400, 800)
    store.tool = 'write'
    const canvas = w.find('canvas').element as HTMLCanvasElement
    tap(canvas, 200, 400)
    const point = currentPage()!.strokes[0].pts[0]
    const scale = initialScale(400, 800)
    const offsetX = (400 - PAGE_W * scale) / 2
    const offsetY = (800 - PAGE_H * scale) / 2
    store.tool = 'transform'

    canvas.dispatchEvent(
      pev('pointermove', {
        pointerId: 4,
        pointerType: 'mouse',
        clientX: (point.x - 15) * scale + offsetX,
        clientY: (point.y - 15) * scale + offsetY,
      }),
    )
    expect(canvas.style.cursor).toBe('nwse-resize')

    canvas.dispatchEvent(
      pev('pointermove', {
        pointerId: 4,
        pointerType: 'mouse',
        clientX: 200,
        clientY: 400 - 15 * scale - 24,
      }),
    )
    expect(canvas.style.cursor).toBe('crosshair')
    w.unmount()
  })

  it('opens the layer panel and adds a selected layer', async () => {
    const w = await mountCanvas()
    await w.findAll('.top-actions button')[2].trigger('click')
    const modal = document.body.querySelector('.mslider-backdrop')
    expect(modal).not.toBeNull()
    expect(modal!.querySelector('.transform-button')).toBeNull()
    ;(modal!.querySelector('.layer-add') as HTMLButtonElement).click()
    await w.vm.$nextTick()
    expect(pageLayers()).toHaveLength(2)
    expect(modal!.querySelector('.layer-row.active')).not.toBeNull()
    expect(currentPage()!.activeLayerId).toBe(pageLayers()[1].id)
    w.unmount()
  })

  it('closes the layer modal from its backdrop', async () => {
    const w = await mountCanvas()
    await w.findAll('.top-actions button')[2].trigger('click')
    const backdrop = document.body.querySelector('.mslider-backdrop')!
    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await w.vm.$nextTick()
    expect(document.body.querySelector('.mslider-backdrop')).toBeNull()
    w.unmount()
  })

  it('reorders layers by dragging the grip handle', async () => {
    const w = await mountCanvas()
    const baseLayer = pageLayers()[0]
    await w.findAll('.top-actions button')[2].trigger('click')
    const modal = document.body.querySelector('.mslider-backdrop')!
    ;(modal.querySelector('.layer-add') as HTMLButtonElement).click()
    await w.vm.$nextTick()
    const rows = [...modal.querySelectorAll<HTMLElement>('.layer-row')]
    const topRow = rows[0]
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(topRow)
    vi.spyOn(topRow, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 300,
      bottom: 42,
      width: 300,
      height: 42,
      toJSON: () => ({}),
    } as DOMRect)

    const grip = rows[1].querySelector('.layer-grab')!
    grip.dispatchEvent(
      pev('pointerdown', {
        pointerId: 7,
        pointerType: 'touch',
        clientX: 20,
        clientY: 60,
        timeStamp: 0,
      }),
    )
    grip.dispatchEvent(
      pev('pointermove', {
        pointerId: 7,
        pointerType: 'touch',
        clientX: 20,
        clientY: 5,
        timeStamp: 16,
      }),
    )
    grip.dispatchEvent(
      pev('pointerup', {
        pointerId: 7,
        pointerType: 'touch',
        clientX: 20,
        clientY: 5,
        timeStamp: 24,
      }),
    )

    expect(pageLayers()[1].id).toBe(baseLayer.id)
    vi.restoreAllMocks()
    w.unmount()
  })

  it('marks strokes drawn on an alpha-locked layer, except the eraser', async () => {
    const w = await mountCanvas()
    updateLayer(pageLayers()[0].id, { alphaLock: true })
    tap(w.find('canvas').element, 200, 400)
    store.tool = 'eraser'
    tap(w.find('canvas').element, 300, 400)
    const strokes = currentPage()!.strokes
    expect(strokes[0].alphaLock).toBe(true)
    expect(strokes[1].alphaLock).toBeUndefined()
    w.unmount()
  })

  it('shows blend mode, alpha lock, clipping controls and thumbnails in the layer panel', async () => {
    const w = await mountCanvas()
    await w.findAll('.top-actions button')[2].trigger('click')
    const modal = document.body.querySelector('.mslider-backdrop')!
    expect(modal.querySelector('.layer-thumb')).not.toBeNull()
    const blend = modal.querySelector<HTMLSelectElement>('.layer-blend')!
    expect(blend).not.toBeNull()
    expect(blend.value).toBe('source-over')
    const flags = [...modal.querySelectorAll<HTMLInputElement>('.layer-flag input')]
    expect(flags).toHaveLength(3)

    blend.value = 'multiply'
    blend.dispatchEvent(new Event('change'))
    flags[0].click()
    flags[1].click()
    flags[2].click()
    expect(pageLayers()[0]).toMatchObject({
      blend: 'multiply',
      alphaLock: true,
      clip: true,
      mask: true,
    })
    w.unmount()
  })

  it('Ctrl+Z undoes, Ctrl+Shift+Z redoes', async () => {
    const w = await mountCanvas()
    const canvas = w.find('canvas').element
    canvas.dispatchEvent(
      pev('pointerdown', {
        pointerId: 1,
        pointerType: 'mouse',
        clientX: 100,
        clientY: 100,
        timeStamp: 0,
        pressure: 0.5,
      }),
    )
    canvas.dispatchEvent(
      pev('pointerup', {
        pointerId: 1,
        pointerType: 'mouse',
        clientX: 100,
        clientY: 100,
        timeStamp: 8,
      }),
    )
    expect(currentPage()!.strokes).toHaveLength(1)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }))
    expect(currentPage()!.strokes).toHaveLength(0)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true }))
    expect(currentPage()!.strokes).toHaveLength(1)
    w.unmount()
  })

  it('stores stroke points in page units, not screen pixels', async () => {
    const w = await mountSized(400, 800)
    const s = initialScale(400, 800)
    const ox = (400 - PAGE_W * s) / 2
    const oy = (800 - PAGE_H * s) / 2
    tap(w.find('canvas').element, 200, 400)
    const pt = currentPage()!.strokes[0].pts[0]
    expect(pt.x).toBeCloseTo((200 - ox) / s)
    expect(pt.y).toBeCloseTo((400 - oy) / s)
    w.unmount()
  })

  it('the move tool pans the sheet, shifting later strokes in page space', async () => {
    const w = await mountSized(400, 800)
    const canvas = w.find('canvas').element
    const s = initialScale(400, 800) * 4
    pinch(canvas, [150, 400], [250, 400], [-50, 400], [350, 400])

    store.tool = 'write'
    tap(canvas, 200, 400)
    const before = currentPage()!.strokes[0].pts[0].x

    store.tool = 'move'
    canvas.dispatchEvent(
      pev('pointerdown', {
        pointerId: 1,
        pointerType: 'mouse',
        clientX: 200,
        clientY: 400,
        timeStamp: 0,
      }),
    )
    canvas.dispatchEvent(
      pev('pointermove', {
        pointerId: 1,
        pointerType: 'mouse',
        clientX: 260,
        clientY: 400,
        timeStamp: 16,
      }),
    )
    canvas.dispatchEvent(
      pev('pointerup', {
        pointerId: 1,
        pointerType: 'mouse',
        clientX: 260,
        clientY: 400,
        timeStamp: 24,
      }),
    )

    store.tool = 'write'
    tap(canvas, 200, 400)
    const after = currentPage()!.strokes[1].pts[0].x
    // sheet moved right by 60 css px -> same tap lands 60/s further left
    expect(after).toBeCloseTo(before - 60 / s)
    w.unmount()
  })

  it('panning is free — the sheet can be dragged far beyond the viewport', async () => {
    const w = await mountSized(400, 800)
    const canvas = w.find('canvas').element
    const s = initialScale(400, 800) * 4
    const ox0 = (400 - PAGE_W * s) / 2
    pinch(canvas, [150, 400], [250, 400], [0, 400], [400, 400])

    store.tool = 'move'
    canvas.dispatchEvent(
      pev('pointerdown', {
        pointerId: 1,
        pointerType: 'mouse',
        clientX: 200,
        clientY: 400,
        timeStamp: 0,
      }),
    )
    canvas.dispatchEvent(
      pev('pointermove', {
        pointerId: 1,
        pointerType: 'mouse',
        clientX: 9999,
        clientY: 400,
        timeStamp: 16,
      }),
    )
    canvas.dispatchEvent(
      pev('pointerup', {
        pointerId: 1,
        pointerType: 'mouse',
        clientX: 9999,
        clientY: 400,
        timeStamp: 24,
      }),
    )

    store.tool = 'write'
    tap(canvas, 200, 400)
    // no clamp: the drag moved ox by +9799, so the tap lands far off-page
    expect(currentPage()!.strokes[0].pts[0].x).toBeCloseTo((200 - ox0 - 9799) / s)
    w.unmount()
  })

  it('pinching in around the center shifts the page mapping outward', async () => {
    const w = await mountSized(400, 800)
    const canvas = w.find('canvas').element
    tap(canvas, 50, 400)
    const before = currentPage()!.strokes[0].pts[0].x

    pinch(canvas, [150, 400], [250, 400], [100, 400], [300, 400])
    tap(canvas, 50, 400)
    const after = currentPage()!.strokes[1].pts[0].x
    expect(after).toBeGreaterThan(before)
    w.unmount()
  })

  it('pinching out bottoms out at half-size contain fit', async () => {
    const w = await mountSized(400, 800)
    const canvas = w.find('canvas').element
    expect(w.find('.canvas-view').attributes('style')).toContain('--tray-height: 60px')
    pinch(canvas, [100, 400], [300, 400], [150, 400], [250, 400])
    pinch(canvas, [100, 400], [300, 400], [150, 400], [250, 400])
    pinch(canvas, [100, 400], [300, 400], [150, 400], [250, 400])

    tap(canvas, 200, 400)
    tap(canvas, 300, 400)
    const center = currentPage()!.strokes[0].pts[0]
    const offset = currentPage()!.strokes[1].pts[0]
    // Half-size contain fit makes 100 css px map to half the page width.
    expect(center.x).toBeCloseTo(PAGE_W / 2, 0)
    expect(center.y).toBeCloseTo(PAGE_H / 2, 0)
    expect(offset.x - center.x).toBeCloseTo(PAGE_W / 2, 0)
    w.unmount()
  })

  it('pinching back out restores the initial contain fit', async () => {
    const w = await mountSized(400, 800)
    const canvas = w.find('canvas').element
    const s = initialScale(400, 800)
    const ox = (400 - PAGE_W * s) / 2

    pinch(canvas, [150, 400], [250, 400], [100, 400], [300, 400])
    pinch(canvas, [100, 400], [300, 400], [150, 400], [250, 400])

    tap(canvas, 200, 400)
    expect(currentPage()!.strokes[0].pts[0].x).toBeCloseTo((200 - ox) / s)
    w.unmount()
  })

  it('a canvas resize keeps the gesture zoom', async () => {
    const w = await mountSized(400, 800)
    const el = w.find('canvas').element
    const canvas = el
    pinch(canvas, [150, 400], [250, 400], [100, 400], [300, 400])

    Object.defineProperty(el, 'clientWidth', { value: 800, configurable: true })
    window.dispatchEvent(new Event('resize'))
    await w.vm.$nextTick()

    tap(canvas, 200, 400)
    const s2 = initialScale(400, 800) * 2
    const ox2 = (800 - PAGE_W * s2) / 2
    expect(currentPage()!.strokes[0].pts[0].x).toBeCloseTo((200 - ox2) / s2)
    w.unmount()
  })

  it('each page remembers its own zoom', async () => {
    const w = await mountSized(400, 800)
    const canvas = w.find('canvas').element
    const s = initialScale(400, 800)
    const ox = (400 - PAGE_W * s) / 2

    pinch(canvas, [150, 400], [250, 400], [100, 400], [300, 400])
    store.pageId = 'p2'
    await w.vm.$nextTick()
    tap(canvas, 50, 400)
    const onP2 = currentPage()!.strokes[0].pts[0].x
    // p2 was never zoomed: plain contain-fit mapping
    expect(onP2).toBeCloseTo((50 - ox) / s)

    store.pageId = 'p1'
    await w.vm.$nextTick()
    tap(canvas, 50, 400)
    // p1 restored its zoomed view: the same tap lands further right
    expect(currentPage()!.strokes[0].pts[0].x).toBeGreaterThan(onP2)
    w.unmount()
  })

  it('the live eraser repaints only the touched region, not the whole page', async () => {
    const backend = mockCanvasBackend()
    try {
      const w = await mountSized(400, 800)
      const canvas = w.find('canvas').element as HTMLCanvasElement
      const ctx = backend.ctxs.get(canvas)!
      tap(canvas, 200, 400) // give the eraser something to erase
      store.tool = 'eraser'
      vi.mocked(ctx.clip).mockClear()

      canvas.dispatchEvent(
        pev('pointerdown', {
          pointerId: 1,
          pointerType: 'mouse',
          clientX: 180,
          clientY: 380,
          timeStamp: 0,
          pressure: 0.5,
        }),
      )
      canvas.dispatchEvent(
        pev('pointermove', {
          pointerId: 1,
          pointerType: 'mouse',
          clientX: 220,
          clientY: 420,
          timeStamp: 16,
          pressure: 0.5,
        }),
      )
      await new Promise((r) => setTimeout(r, 0)) // let the scheduled rAF fire

      // A clipped dirty-region repaint — a full snapshot rebuild never clips
      // the display context.
      expect(ctx.clip).toHaveBeenCalled()
      canvas.dispatchEvent(
        pev('pointerup', {
          pointerId: 1,
          pointerType: 'mouse',
          clientX: 220,
          clientY: 420,
          timeStamp: 24,
        }),
      )
      expect(currentPage()!.strokes.at(-1)!.tool).toBe('eraser')
      w.unmount()
    } finally {
      backend.restore()
    }
  })

  it('cancelling a live erase with a second finger restores the raster, not replays it', async () => {
    const backend = mockCanvasBackend()
    try {
      const w = await mountSized(400, 800)
      const canvas = w.find('canvas').element as HTMLCanvasElement
      tap(canvas, 200, 400) // content to erase
      store.tool = 'eraser'
      // The layer raster is the first canvas grown to the 3072px raster width.
      const raster = backend.canvases.find((c) => c.width === 3072)!
      const rctx = backend.ctxs.get(raster)!
      vi.mocked(rctx.clearRect).mockClear()
      vi.mocked(rctx.drawImage).mockClear()

      // Finger 1 starts erasing, finger 2 begins the pinch -> cancel.
      canvas.dispatchEvent(
        pev('pointerdown', {
          pointerId: 1,
          pointerType: 'touch',
          clientX: 180,
          clientY: 380,
          timeStamp: 0,
          pressure: 0.5,
        }),
      )
      canvas.dispatchEvent(
        pev('pointermove', {
          pointerId: 1,
          pointerType: 'touch',
          clientX: 200,
          clientY: 400,
          timeStamp: 8,
          pressure: 0.5,
        }),
      )
      canvas.dispatchEvent(
        pev('pointerdown', {
          pointerId: 2,
          pointerType: 'touch',
          clientX: 220,
          clientY: 420,
          timeStamp: 9,
        }),
      )

      expect(currentPage()!.strokes).toHaveLength(1) // the cancelled stroke is not committed
      // The pre-stroke copy is drawn back — the raster is NOT rebuilt from a
      // full layer replay (which is what made pinch-start stutter).
      expect(rctx.drawImage).toHaveBeenCalled()
      expect(rctx.clearRect).not.toHaveBeenCalled()
      canvas.dispatchEvent(
        pev('pointerup', {
          pointerId: 1,
          pointerType: 'touch',
          clientX: 200,
          clientY: 400,
          timeStamp: 20,
        }),
      )
      canvas.dispatchEvent(
        pev('pointerup', {
          pointerId: 2,
          pointerType: 'touch',
          clientX: 220,
          clientY: 420,
          timeStamp: 21,
        }),
      )
      w.unmount()
    } finally {
      backend.restore()
    }
  })

  it('each page remembers its own rotation', async () => {
    const w = await mountSized(400, 800)
    const canvas = w.find('canvas').element as HTMLCanvasElement

    pinch(canvas, [300, 400], [200, 400], [250, 450], [250, 350])
    store.pageId = 'p2'
    await w.vm.$nextTick()
    expect(viewAngle(w)).toBe(0)

    store.pageId = 'p1'
    await w.vm.$nextTick()
    expect(viewAngle(w)).toBeCloseTo(Math.PI / 2)
    w.unmount()
  })
})
