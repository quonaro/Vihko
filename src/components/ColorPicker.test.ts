import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, VueWrapper } from '@vue/test-utils'
import ColorPicker from './ColorPicker.vue'
import { i18n } from '../i18n'
import { store } from '../store'

function pev(type: string, props: Record<string, unknown> = {}) {
  const e = new Event(type, { bubbles: true })
  for (const [k, v] of Object.entries(props)) {
    Object.defineProperty(e, k, { value: v, configurable: true })
  }
  return e
}

function rect(el: Element, r: { left: number; top: number; width: number; height: number }) {
  ;(el as HTMLElement).getBoundingClientRect = () =>
    ({ ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON: () => {} }) as DOMRect
}

const dialog = () => document.body.querySelector('[role="dialog"]')
const q = <T extends Element = HTMLElement>(sel: string) =>
  document.body.querySelector(sel) as T | null

let w: VueWrapper | null = null
const mountPicker = (open = true) =>
  (w = mount(ColorPicker, { props: { open }, global: { plugins: [i18n] } }))

beforeEach(() => {
  store.color = '#ff0000'
})
afterEach(() => {
  w?.unmount()
  w = null
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

  it('the previous-color swatch restores the opening color', async () => {
    mountPicker()
    const hex = q<HTMLInputElement>('input.hex')!
    hex.value = '#00ff00'
    hex.dispatchEvent(new Event('input'))
    await w!.vm.$nextTick()
    expect(store.color).toBe('#00ff00')
    q('.old')!.dispatchEvent(new Event('click', { bubbles: true }))
    await w!.vm.$nextTick()
    expect(store.color).toBe('#ff0000')
    expect(q<HTMLInputElement>('input.hex')!.value).toBe('#ff0000')
  })

  it('closing the dialog emits update:open false', async () => {
    mountPicker()
    q('button.close')!.dispatchEvent(new Event('click', { bubbles: true }))
    await w!.vm.$nextTick()
    expect(w!.emitted('update:open')).toEqual([[false]])
  })
})
