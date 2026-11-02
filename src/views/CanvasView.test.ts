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

const tap = (canvas: Element, x: number, y: number) => {
  canvas.dispatchEvent(pev('pointerdown', {
    pointerId: 1, pointerType: 'mouse', clientX: x, clientY: y, timeStamp: 0, pressure: 0.5,
  }))
  canvas.dispatchEvent(pev('pointerup', {
    pointerId: 1, pointerType: 'mouse', clientX: x, clientY: y, timeStamp: 8,
  }))
}

function pev(type: string, props: Record<string, unknown> = {}) {
  const e = new Event(type, { bubbles: true })
  for (const [k, v] of Object.entries(props)) {
    Object.defineProperty(e, k, { value: v, configurable: true })
  }
  return e
}

const journal = (): Journal => ({
  id: 'j1', title: 'Field Notes', cover: 0, createdAt: 0,
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

  it('a pen drag commits a stroke into the store', async () => {
    const w = await mountCanvas()
    const canvas = w.find('canvas').element
    canvas.dispatchEvent(pev('pointerdown', {
      pointerId: 1, pointerType: 'mouse', clientX: 100, clientY: 100, timeStamp: 0, pressure: 0.5,
    }))
    canvas.dispatchEvent(pev('pointermove', {
      pointerId: 1, pointerType: 'mouse', clientX: 140, clientY: 120, timeStamp: 16, pressure: 0.5,
    }))
    canvas.dispatchEvent(pev('pointermove', {
      pointerId: 1, pointerType: 'mouse', clientX: 180, clientY: 140, timeStamp: 32, pressure: 0.5,
    }))
    canvas.dispatchEvent(pev('pointerup', {
      pointerId: 1, pointerType: 'mouse', clientX: 180, clientY: 140, timeStamp: 40,
    }))
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
    canvas.dispatchEvent(pev('pointerdown', {
      pointerId: 1, pointerType: 'mouse', clientX: 100, clientY: 100, timeStamp: 0, pressure: 0.5,
    }))
    canvas.dispatchEvent(pev('pointermove', {
      pointerId: 1, pointerType: 'mouse', clientX: 170, clientY: 150, timeStamp: 16, pressure: 0.5,
    }))
    canvas.dispatchEvent(pev('pointerup', {
      pointerId: 1, pointerType: 'mouse', clientX: 170, clientY: 150, timeStamp: 24, pressure: 0.5,
    }))

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
    canvas.dispatchEvent(pev('pointerdown', {
      pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 350, timeStamp: 0,
    }))
    canvas.dispatchEvent(pev('pointerdown', {
      pointerId: 2, pointerType: 'touch', clientX: 200, clientY: 350, timeStamp: 1,
    }))
    canvas.dispatchEvent(pev('pointermove', {
      pointerId: 2, pointerType: 'touch', clientX: 300, clientY: 370, timeStamp: 16,
    }))
    await w.vm.$nextTick()
    expect(w.find('.zoom-actions .fit-btn').exists()).toBe(true)
    canvas.dispatchEvent(pev('pointerup', {
      pointerId: 2, pointerType: 'touch', clientX: 300, clientY: 370, timeStamp: 24,
    }))
    canvas.dispatchEvent(pev('pointerup', {
      pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 350, timeStamp: 25,
    }))
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
    canvas.dispatchEvent(pev('pointerdown', {
      pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 300, timeStamp: 0,
    }))
    canvas.dispatchEvent(pev('pointermove', {
      pointerId: 1, pointerType: 'touch', clientX: 140, clientY: 330, timeStamp: 16,
    }))
    expect(pageLayers().find((item) => item.id === layer.id)?.x).toBe(0)
    expect(pageRev(currentPage()!)).toBe(revision)
    canvas.dispatchEvent(pev('pointerup', {
      pointerId: 1, pointerType: 'touch', clientX: 140, clientY: 330, timeStamp: 24,
    }))
    expect(pageLayers().find((item) => item.id === layer.id)?.x).toBeCloseTo(40 / (800 / PAGE_H))
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
    canvas.dispatchEvent(pev('pointerdown', {
      pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 300, timeStamp: 0,
    }))
    for (const [x, timeStamp] of [[120, 8], [140, 16], [160, 24]] as const) {
      canvas.dispatchEvent(pev('pointermove', {
        pointerId: 1, pointerType: 'touch', clientX: x, clientY: 300, timeStamp,
      }))
    }

    expect(requestFrame).toHaveBeenCalledTimes(1)
    canvas.dispatchEvent(pev('pointerup', {
      pointerId: 1, pointerType: 'touch', clientX: 180, clientY: 300, timeStamp: 32,
    }))

    expect(pageLayers().find((item) => item.id === layer.id)?.x).toBeCloseTo(80 / (800 / PAGE_H))
    requestFrame.mockRestore()
    w.unmount()
  })

  it('the transform tool does not move an empty layer', async () => {
    const w = await mountSized(400, 800)
    const layer = addLayer()!
    const revision = pageRev(currentPage()!)
    const canvas = w.find('canvas').element
    store.tool = 'transform'
    canvas.dispatchEvent(pev('pointerdown', {
      pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 300, timeStamp: 0,
    }))
    canvas.dispatchEvent(pev('pointermove', {
      pointerId: 1, pointerType: 'touch', clientX: 140, clientY: 330, timeStamp: 16,
    }))
    canvas.dispatchEvent(pev('pointerup', {
      pointerId: 1, pointerType: 'touch', clientX: 140, clientY: 330, timeStamp: 24,
    }))
    expect(pageLayers().find((item) => item.id === layer.id)?.x).toBe(0)
    expect(pageRev(currentPage()!)).toBe(revision)
    w.unmount()
  })

  it('draws under the pointer on a moved, scaled, and rotated layer', async () => {
    const w = await mountSized(400, 800)
    const layer = pageLayers()[0]
    updateLayer(layer.id, { x: 24, y: -18, scale: 1.4, rotation: 31 })
    const screen = { x: 210, y: 420 }
    const s = 800 / PAGE_H
    const ox = (400 - PAGE_W * s) / 2
    const expected = { x: (screen.x - ox) / s, y: screen.y / s }

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
    const scale = 800 / PAGE_H
    const offsetX = (400 - PAGE_W * scale) / 2
    const x = (point.x - 15) * scale + offsetX
    const y = (point.y - 15) * scale

    store.tool = 'transform'
    canvas.dispatchEvent(pev('pointerdown', {
      pointerId: 1, pointerType: 'touch', clientX: x, clientY: y, timeStamp: 0,
    }))
    canvas.dispatchEvent(pev('pointermove', {
      pointerId: 1, pointerType: 'touch', clientX: x - 20, clientY: y - 20, timeStamp: 16,
    }))
    expect(pageLayers()[0].scale).toBe(1)
    canvas.dispatchEvent(pev('pointerup', {
      pointerId: 1, pointerType: 'touch', clientX: x - 20, clientY: y - 20, timeStamp: 24,
    }))
    expect(pageLayers()[0].scale).toBeGreaterThan(1)
    w.unmount()
  })

  it('rotates the active layer from the frame rotation handle', async () => {
    const w = await mountSized(400, 800)
    store.tool = 'write'
    const canvas = w.find('canvas').element
    tap(canvas, 200, 400)
    store.tool = 'transform'
    const handleY = 400 - 15 * (800 / PAGE_H) - 24
    canvas.dispatchEvent(pev('pointerdown', {
      pointerId: 1, pointerType: 'touch', clientX: 200, clientY: handleY, timeStamp: 0,
    }))
    canvas.dispatchEvent(pev('pointermove', {
      pointerId: 1, pointerType: 'touch', clientX: 230, clientY: 400, timeStamp: 16,
    }))
    expect(pageLayers()[0].rotation).toBe(0)
    canvas.dispatchEvent(pev('pointerup', {
      pointerId: 1, pointerType: 'touch', clientX: 230, clientY: 400, timeStamp: 24,
    }))
    expect(pageLayers()[0].rotation).toBeCloseTo(90)
    w.unmount()
  })

  it('shows resize and rotation cursors when hovering transform handles', async () => {
    const w = await mountSized(400, 800)
    store.tool = 'write'
    const canvas = w.find('canvas').element as HTMLCanvasElement
    tap(canvas, 200, 400)
    const point = currentPage()!.strokes[0].pts[0]
    const scale = 800 / PAGE_H
    const offsetX = (400 - PAGE_W * scale) / 2
    store.tool = 'transform'

    canvas.dispatchEvent(pev('pointermove', {
      pointerId: 4, pointerType: 'mouse',
      clientX: (point.x - 15) * scale + offsetX, clientY: (point.y - 15) * scale,
    }))
    expect(canvas.style.cursor).toBe('nwse-resize')

    canvas.dispatchEvent(pev('pointermove', {
      pointerId: 4, pointerType: 'mouse',
      clientX: 200, clientY: 400 - 15 * scale - 24,
    }))
    expect(canvas.style.cursor).toBe('crosshair')
    w.unmount()
  })

  it('opens the layer panel and adds a selected layer', async () => {
    const w = await mountCanvas()
    await w.findAll('.top-actions button')[2].trigger('click')
    const modal = document.body.querySelector('.layer-modal-backdrop')
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
    const backdrop = document.body.querySelector('.layer-modal-backdrop')!
    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await w.vm.$nextTick()
    expect(document.body.querySelector('.layer-modal-backdrop')).toBeNull()
    w.unmount()
  })

  it('reorders layers by dragging the grip handle', async () => {
    const w = await mountCanvas()
    const baseLayer = pageLayers()[0]
    await w.findAll('.top-actions button')[2].trigger('click')
    const modal = document.body.querySelector('.layer-modal-backdrop')!
    ;(modal.querySelector('.layer-add') as HTMLButtonElement).click()
    await w.vm.$nextTick()
    const rows = [...modal.querySelectorAll<HTMLElement>('.layer-row')]
    const topRow = rows[0]
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(topRow)
    vi.spyOn(topRow, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 300, bottom: 42, width: 300, height: 42,
      toJSON: () => ({}),
    } as DOMRect)

    const grip = rows[1].querySelector('.layer-grab')!
    grip.dispatchEvent(pev('pointerdown', {
      pointerId: 7, pointerType: 'touch', clientX: 20, clientY: 60, timeStamp: 0,
    }))
    grip.dispatchEvent(pev('pointermove', {
      pointerId: 7, pointerType: 'touch', clientX: 20, clientY: 5, timeStamp: 16,
    }))
    grip.dispatchEvent(pev('pointerup', {
      pointerId: 7, pointerType: 'touch', clientX: 20, clientY: 5, timeStamp: 24,
    }))

    expect(pageLayers()[1].id).toBe(baseLayer.id)
    vi.restoreAllMocks()
    w.unmount()
  })

  it('Ctrl+Z undoes, Ctrl+Shift+Z redoes', async () => {
    const w = await mountCanvas()
    const canvas = w.find('canvas').element
    canvas.dispatchEvent(pev('pointerdown', {
      pointerId: 1, pointerType: 'mouse', clientX: 100, clientY: 100, timeStamp: 0, pressure: 0.5,
    }))
    canvas.dispatchEvent(pev('pointerup', {
      pointerId: 1, pointerType: 'mouse', clientX: 100, clientY: 100, timeStamp: 8,
    }))
    expect(currentPage()!.strokes).toHaveLength(1)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }))
    expect(currentPage()!.strokes).toHaveLength(0)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true }))
    expect(currentPage()!.strokes).toHaveLength(1)
    w.unmount()
  })

  it('stores stroke points in page units, not screen pixels', async () => {
    const w = await mountSized(400, 800)
    // cover fit for a 400x800 viewport: height-driven scale, page overflows x.
    const s = 800 / PAGE_H
    const ox = (400 - PAGE_W * s) / 2
    tap(w.find('canvas').element, 200, 400)
    const pt = currentPage()!.strokes[0].pts[0]
    expect(pt.x).toBeCloseTo((200 - ox) / s)
    expect(pt.y).toBeCloseTo(400 / s)
    w.unmount()
  })

  it('the move tool pans the sheet, shifting later strokes in page space', async () => {
    const w = await mountSized(400, 800)
    const canvas = w.find('canvas').element
    const s = 800 / PAGE_H

    store.tool = 'write'
    tap(canvas, 200, 400)
    const before = currentPage()!.strokes[0].pts[0].x

    store.tool = 'move'
    canvas.dispatchEvent(pev('pointerdown', {
      pointerId: 1, pointerType: 'mouse', clientX: 200, clientY: 400, timeStamp: 0,
    }))
    canvas.dispatchEvent(pev('pointermove', {
      pointerId: 1, pointerType: 'mouse', clientX: 260, clientY: 400, timeStamp: 16,
    }))
    canvas.dispatchEvent(pev('pointerup', {
      pointerId: 1, pointerType: 'mouse', clientX: 260, clientY: 400, timeStamp: 24,
    }))

    store.tool = 'write'
    tap(canvas, 200, 400)
    const after = currentPage()!.strokes[1].pts[0].x
    // sheet moved right by 60 css px -> same tap lands 60/s further left
    expect(after).toBeCloseTo(before - 60 / s)
    w.unmount()
  })

  it('panning is clamped so the sheet always covers the viewport', async () => {
    const w = await mountSized(400, 800)
    const canvas = w.find('canvas').element
    const s = 800 / PAGE_H

    store.tool = 'move'
    canvas.dispatchEvent(pev('pointerdown', {
      pointerId: 1, pointerType: 'mouse', clientX: 200, clientY: 400, timeStamp: 0,
    }))
    canvas.dispatchEvent(pev('pointermove', {
      pointerId: 1, pointerType: 'mouse', clientX: 9999, clientY: 400, timeStamp: 16,
    }))
    canvas.dispatchEvent(pev('pointerup', {
      pointerId: 1, pointerType: 'mouse', clientX: 9999, clientY: 400, timeStamp: 24,
    }))

    store.tool = 'write'
    tap(canvas, 200, 400)
    // clamped at ox = 0: page x is exactly clientX / s
    expect(currentPage()!.strokes[0].pts[0].x).toBeCloseTo(200 / s)
    w.unmount()
  })

  it('zooming in around the center shifts the page mapping outward', async () => {
    const w = await mountSized(400, 800)
    const canvas = w.find('canvas').element
    tap(canvas, 50, 400)
    const before = currentPage()!.strokes[0].pts[0].x

    await w.findAll('.zoom-actions button')[0].trigger('click') // zoom in
    tap(canvas, 50, 400)
    const after = currentPage()!.strokes[1].pts[0].x
    // same css point now lands further right in page units
    expect(after).toBeGreaterThan(before)
    w.unmount()
  })

  it('zoom-out bottoms out at half-size contain fit', async () => {
    const w = await mountSized(400, 800)
    const canvas = w.find('canvas').element
    expect(w.find('.canvas-view').attributes('style')).toContain('--tray-height: 86px')
    const out = w.findAll('.zoom-actions button')[1]
    for (let i = 0; i < 12; i++) await out.trigger('click')
    expect(out.attributes('disabled')).toBeDefined()

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

  it('the fit button restores the cover viewport after zooming', async () => {
    const w = await mountSized(400, 800)
    const canvas = w.find('canvas').element
    const s = 800 / PAGE_H
    const ox = (400 - PAGE_W * s) / 2

    await w.findAll('.zoom-actions button')[0].trigger('click') // zoom in
    const fit = w.find('.zoom-actions .fit-btn')
    // the fit button leads the zoom stack
    expect(w.findAll('.zoom-actions button')[0].element).toBe(fit.element)
    await fit.trigger('click')

    tap(canvas, 200, 400)
    expect(currentPage()!.strokes[0].pts[0].x).toBeCloseTo((200 - ox) / s)
    w.unmount()
  })

  it('a canvas resize re-evaluates the fit button and keeps the view', async () => {
    const w = await mountSized(400, 800)
    const el = w.find('canvas').element
    const canvas = el
    expect(w.find('.zoom-actions .fit-btn').exists()).toBe(false)

    await w.findAll('.zoom-actions button')[0].trigger('click') // zoom in
    expect(w.find('.zoom-actions .fit-btn').exists()).toBe(true)

    // resized while zoomed: view survives and the fit button stays visible
    Object.defineProperty(el, 'clientWidth', { value: 800, configurable: true })
    window.dispatchEvent(new Event('resize'))
    await w.vm.$nextTick()
    expect(w.find('.zoom-actions .fit-btn').exists()).toBe(true)

    tap(canvas, 200, 400)
    const s2 = (800 / PAGE_H) * 1.4 // new cover scale (height-driven) x kept zoom
    const ox2 = (800 - PAGE_W * s2) / 2
    expect(currentPage()!.strokes[0].pts[0].x).toBeCloseTo((200 - ox2) / s2)

    // back at cover fit, a resize leaves the fit button hidden
    await w.find('.zoom-actions .fit-btn').trigger('click')
    Object.defineProperty(el, 'clientWidth', { value: 400, configurable: true })
    window.dispatchEvent(new Event('resize'))
    await w.vm.$nextTick()
    expect(w.find('.zoom-actions .fit-btn').exists()).toBe(false)
    w.unmount()
  })

  it('each page remembers its own zoom', async () => {
    const w = await mountSized(400, 800)
    const canvas = w.find('canvas').element
    const s = 800 / PAGE_H
    const ox = (400 - PAGE_W * s) / 2

    await w.findAll('.zoom-actions button')[0].trigger('click') // zoom in on p1
    store.pageId = 'p2'
    await w.vm.$nextTick()
    tap(canvas, 50, 400)
    const onP2 = currentPage()!.strokes[0].pts[0].x
    // p2 was never zoomed: plain cover-fit mapping
    expect(onP2).toBeCloseTo((50 - ox) / s)

    store.pageId = 'p1'
    await w.vm.$nextTick()
    tap(canvas, 50, 400)
    // p1 restored its zoomed view: the same tap lands further right
    expect(currentPage()!.strokes[0].pts[0].x).toBeGreaterThan(onP2)
    w.unmount()
  })
})
