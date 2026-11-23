import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import ShelfFlat from './ShelfFlat.vue'
import { i18n } from '../i18n'
import type { Journal } from '../types'

const journal = {
  id: 'j1',
  title: 'Journal',
  cover: 0,
  pages: [],
} as unknown as Journal

function pev(type: string, props: Record<string, unknown> = {}) {
  const e = new Event(type, { bubbles: true })
  for (const [k, v] of Object.entries(props)) {
    Object.defineProperty(e, k, { value: v, configurable: true })
  }
  return e
}

const mountShelf = () =>
  mount(ShelfFlat, { props: { journals: [journal] }, global: { plugins: [i18n] } })

const point = (x = 10, y = 10) => ({ clientX: x, clientY: y })

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ShelfFlat', () => {
  it('opens the journal menu after a long press and swallows the click', async () => {
    const w = mountShelf()
    const card = w.find('.book-card').element

    card.dispatchEvent(pev('pointerdown', point()))
    vi.advanceTimersByTime(560)
    await w.vm.$nextTick()

    expect(w.emitted('menu')).toEqual([['j1']])

    card.dispatchEvent(pev('click'))
    await w.vm.$nextTick()
    expect(w.emitted('open')).toBeUndefined()
  })

  it('keeps a short tap opening the journal', async () => {
    const w = mountShelf()
    const card = w.find('.book-card').element

    card.dispatchEvent(pev('pointerdown', point()))
    vi.advanceTimersByTime(100)
    card.dispatchEvent(pev('pointerup', point()))
    card.dispatchEvent(pev('click'))
    vi.advanceTimersByTime(120)
    await w.vm.$nextTick()

    expect(w.emitted('menu')).toBeUndefined()
    expect(w.emitted('open')).toEqual([['j1']])
  })

  it('cancels the long press once the pointer travels', async () => {
    const w = mountShelf()
    const card = w.find('.book-card').element

    card.dispatchEvent(pev('pointerdown', point()))
    card.dispatchEvent(pev('pointermove', point(60, 60)))
    vi.advanceTimersByTime(600)
    await w.vm.$nextTick()

    expect(w.emitted('menu')).toBeUndefined()
  })
})
