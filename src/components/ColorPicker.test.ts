import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import ColorPicker from './ColorPicker.vue'
import { i18n } from '../i18n'
import { palette, store } from '../store'
import { mixColors } from '../ink/mix'

function pev(type: string, props: Record<string, unknown> = {}) {
  const e = new Event(type, { bubbles: true })
  for (const [k, v] of Object.entries(props)) {
    Object.defineProperty(e, k, { value: v, configurable: true })
  }
  return e
}

function rect(el: Element, r: { left: number; top: number; width: number; height: number }) {
  ;(el as HTMLElement).getBoundingClientRect = () =>
    ({
      ...r,
      right: r.left + r.width,
      bottom: r.top + r.height,
      x: r.left,
      y: r.top,
      toJSON: () => {},
    }) as DOMRect
}

const dialog = () => document.body.querySelector('[role="dialog"]')
const q = <T extends Element = HTMLElement>(sel: string) =>
  document.body.querySelector(sel) as T | null

let w: VueWrapper | null = null
let originalElementFromPoint: typeof document.elementFromPoint
const mountPicker = (open = true) =>
  (w = mount(ColorPicker, { props: { open }, global: { plugins: [i18n] } }))

beforeEach(() => {
  store.color = '#ff0000'
  originalElementFromPoint = document.elementFromPoint
})
afterEach(() => {
  w?.unmount()
  w = null
  document.elementFromPoint = originalElementFromPoint
})

describe('ColorPicker', () => {
  it('teleports a dialog into body only while open', async () => {
    mountPicker(false)
    expect(dialog()).toBeNull()
    await w!.setProps({ open: true })
    expect(dialog()).not.toBeNull()
  })

  it('shows the current color in the hex field on open', () => {
    store.color = '#4a6b8a'
    mountPicker()
    expect(q<HTMLInputElement>('input.hex')!.value).toBe('#4a6b8a')
  })

  it('shows the palette in the color dialog and selects a color', async () => {
    mountPicker()
    expect(document.body.querySelectorAll('.dot')).toHaveLength(palette.length)
    const dot = q<HTMLButtonElement>(`.dot[aria-label="${palette[4]}"]`)!
    dot.dispatchEvent(pev('pointerdown', { clientX: 5, clientY: 5, pointerId: 1 }))
    dot.dispatchEvent(pev('pointerup', { clientX: 5, clientY: 5, movementY: 0, pointerId: 1 }))
    await w!.vm.$nextTick()

    expect(store.color).toBe(palette[4])
    expect(q<HTMLInputElement>('input.hex')!.value).toBe(palette[4])
    expect(dot.classList.contains('active')).toBe(true)
  })

  it('cancelling a palette drag drops the ghost without changing color', async () => {
    mountPicker()
    const before = store.color
    const dot = q<HTMLButtonElement>(`.dot[aria-label="${palette[2]}"]`)!
    dot.dispatchEvent(pev('pointerdown', { clientX: 5, clientY: 5, pointerId: 1 }))
    await w!.vm.$nextTick()
    expect(q('.ghost')).not.toBeNull()
    dot.dispatchEvent(pev('pointercancel', { pointerId: 1 }))
    await w!.vm.$nextTick()

    expect(q('.ghost')).toBeNull()
    expect(store.color).toBe(before)
  })

  it('dropping a palette color on the current swatch mixes it in', async () => {
    mountPicker()
    const before = store.color
    document.elementFromPoint = () => q('.new')!
    const dot = q<HTMLButtonElement>(`.dot[aria-label="${palette[3]}"]`)!
    dot.dispatchEvent(pev('pointerdown', { clientX: 5, clientY: 5, pointerId: 1 }))
    dot.dispatchEvent(pev('pointerup', { clientX: 40, clientY: 40, movementY: 60, pointerId: 1 }))
    await w!.vm.$nextTick()

    const mixed = mixColors(before, palette[3], 0.35)
    expect(store.color).toBe(mixed)
    expect(q<HTMLInputElement>('input.hex')!.value).toBe(mixed)
  })

  it('typing a valid hex applies it to the store', async () => {
    mountPicker()
    const hex = q<HTMLInputElement>('input.hex')!
    hex.value = '3f8f8a'
    hex.dispatchEvent(new Event('input'))
    await w!.vm.$nextTick()
    expect(store.color).toBe('#3f8f8a')
    expect(hex.classList.contains('bad')).toBe(false)
  })

  it('marks invalid hex input without changing the color', async () => {
    mountPicker()
    const hex = q<HTMLInputElement>('input.hex')!
    hex.value = 'nope'
    hex.dispatchEvent(new Event('input'))
    await w!.vm.$nextTick()
    expect(store.color).toBe('#ff0000')
    expect(hex.classList.contains('bad')).toBe(true)
  })

  it('dragging in the SV square updates saturation and value', () => {
    mountPicker()
    const sv = q('.sv')!
    rect(sv, { left: 0, top: 0, width: 100, height: 100 })
    sv.dispatchEvent(pev('pointerdown', { clientX: 50, clientY: 25, pointerId: 1 }))
    // h=0 (from #ff0000), s=0.5, v=0.75 -> rgb(0.75, 0.375, 0.375)
    expect(store.color).toBe('#bf6060')
    sv.dispatchEvent(pev('pointerup', { pointerId: 1 }))
  })

  it('dragging on the hue strip shifts the hue', () => {
    mountPicker()
    const hue = q('.hue')!
    rect(hue, { left: 0, top: 0, width: 100, height: 20 })
    hue.dispatchEvent(pev('pointerdown', { clientX: 50, clientY: 10, pointerId: 1 }))
    expect(store.color).toBe('#00ffff') // h=180, s=1, v=1
    hue.dispatchEvent(pev('pointerup', { pointerId: 1 }))
  })

  it('shows only the current-color swatch', () => {
    mountPicker()
    expect(q('.old')).toBeNull()
    expect(q('.new')).not.toBeNull()
  })

  it('closing the dialog emits update:open false', async () => {
    mountPicker()
    q('button.close')!.dispatchEvent(new Event('click', { bubbles: true }))
    await w!.vm.$nextTick()
    expect(w!.emitted('update:open')).toEqual([[false]])
  })
})
