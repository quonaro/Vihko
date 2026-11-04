import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import CanvasView from './CanvasView.vue'
import { i18n } from '../i18n'
import { store, currentPage, pageLayers, addLayer, updateLayer, pageRev } from '../store'
import { PAGE_W, PAGE_H } from '../pageSpace'
import type { Journal } from '../types'

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
