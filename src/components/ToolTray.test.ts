import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import ToolTray from './ToolTray.vue'
import { i18n } from '../i18n'
import { store } from '../store'

const mountTray = () => mount(ToolTray, { global: { plugins: [i18n] } })

beforeEach(() => {
  store.tool = 'draw'
  store.shape = 'rectangle'
  store.color = '#22221f'
})

describe('ToolTray', () => {
  it('renders the eleven available tools without the color palette', () => {
    const w = mountTray()
    expect(w.findAll('.tool')).toHaveLength(11)
    expect(w.find('.tool[title="Диаграмма"]').exists()).toBe(false)
    expect(w.find(`.tool[title="${i18n.global.t('tool.move')}"]`).exists()).toBe(false)
    expect(w.find(`.action[title="${i18n.global.t('canvas.newPage')}"]`).exists()).toBe(false)
    expect(w.find(`.action[title="${i18n.global.t('canvas.clearPage')}"]`).exists()).toBe(false)
    expect(w.find('.tools').element.firstElementChild).toBe(
      w.find(`.action[title="${i18n.global.t('canvas.photo')}"]`).element,
    )
    expect(w.findAll('.dot')).toHaveLength(0)
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
})
