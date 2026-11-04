import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import ToolTray from './ToolTray.vue'
import { i18n } from '../i18n'
import { store, palette } from '../store'
import { mixColors } from '../ink/mix'

function pev(type: string, props: Record<string, unknown> = {}) {
  const e = new Event(type, { bubbles: true })
  for (const [k, v] of Object.entries(props)) {
    Object.defineProperty(e, k, { value: v, configurable: true })
  }
  return e
}

const mountTray = () => mount(ToolTray, { global: { plugins: [i18n] } })

beforeEach(() => {
  store.tool = 'draw'
  store.shape = 'rectangle'
  store.color = '#22221f'
})

describe('ToolTray', () => {
  it('renders the twelve available tools and the full palette', () => {
    const w = mountTray()
    expect(w.findAll('.tool')).toHaveLength(12)
    expect(w.find('.tool[title="Диаграмма"]').exists()).toBe(false)
    expect(w.findAll('.dot')).toHaveLength(palette.length)
    expect(w.find('.swatch').exists()).toBe(true)
  })

  it('opens the shape context menu and activates the chosen shape', async () => {
    const w = mountTray()
    const toolTitle = i18n.global.t('tool.shapes')
    await w.find(`.tool[title="${toolTitle}"]`).trigger('click')
    expect(document.body.querySelector('[role="menu"]')).not.toBeNull()

    const ellipseLabel = i18n.global.t('shapeMenu.ellipse')
    document.body
      .querySelector<HTMLButtonElement>(`.shape-option[aria-label="${ellipseLabel}"]`)!
      .click()
    await w.vm.$nextTick()
    expect(store.tool).toBe('shapes')
    expect(store.shape).toBe('ellipse')
    expect(document.body.querySelector('[role="menu"]')).toBeNull()
    w.unmount()
  })

  it('clicking the color swatch opens the picker dialog', async () => {
    const w = mountTray()
    await w.find('.swatch').trigger('click')
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
    w.unmount()
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })

  it('clicking a tool selects it', async () => {
    const w = mountTray()
    const buttons = w.findAll('.tool')
    await buttons[3].trigger('click') // outline
    expect(store.tool).toBe('outline')
    expect(buttons[3].classes()).toContain('active')
    await buttons[1].trigger('click') // draw
    expect(store.tool).toBe('draw')
    expect(buttons[3].classes()).not.toContain('active')
  })

  it('marks the active tool on mount', () => {
    store.tool = 'sketch'
    const w = mountTray()
    const active = w.findAll('.tool.active')
    expect(active).toHaveLength(1)
    expect(active[0].attributes('title')).toBe(i18n.global.t('tool.sketch'))
  })

  it('tapping a color dot picks that color', async () => {
    const w = mountTray()
    const dot = w.findAll('.dot')[4]
    const color = palette[4]
    dot.element.dispatchEvent(pev('pointerdown', { clientX: 5, clientY: 5, pointerId: 1 }))
    await w.vm.$nextTick()
    expect(w.find('.ghost').exists()).toBe(true)
    dot.element.dispatchEvent(
      pev('pointerup', { clientX: 5, clientY: 5, movementY: 0, pointerId: 1 }),
    )
    expect(store.color).toBe(color)
    await w.vm.$nextTick()
    expect(w.find('.ghost').exists()).toBe(false)
  })

  it('a cancelled dot drag (e.g. tray scroll) drops the ghost without picking', async () => {
    const before = store.color
    const w = mountTray()
    const dot = w.findAll('.dot')[2]
    dot.element.dispatchEvent(pev('pointerdown', { clientX: 5, clientY: 5, pointerId: 1 }))
    await w.vm.$nextTick()
    expect(w.find('.ghost').exists()).toBe(true)
    dot.element.dispatchEvent(pev('pointercancel', { pointerId: 1 }))
    await w.vm.$nextTick()
    expect(w.find('.ghost').exists()).toBe(false)
    expect(store.color).toBe(before)
  })

  it('dropping a dot on the color swatch mixes into the current color', async () => {
    const before = store.color
    const w = mountTray()
    document.elementFromPoint = () => w.find('.swatch').element
    const dot = w.findAll('.dot')[3]
    dot.element.dispatchEvent(pev('pointerdown', { clientX: 5, clientY: 5, pointerId: 1 }))
    dot.element.dispatchEvent(
      pev('pointerup', { clientX: 40, clientY: 40, movementY: 60, pointerId: 1 }),
    )
    expect(store.color).toBe(mixColors(before, palette[3], 0.35))
    document.elementFromPoint = () => null
  })
})
