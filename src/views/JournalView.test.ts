import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import JournalView from './JournalView.vue'
import { i18n } from '../i18n'
import { closeToJournal, openPage, store } from '../store'
import type { Journal } from '../types'

const mountJournal = () => mount(JournalView, { global: { plugins: [i18n] } })

const journal = (): Journal => ({
  id: 'j1', title: 'Field Notes', cover: 2, createdAt: 0,
  pages: [
    { id: 'p1', strokes: [], createdAt: 0 },
    { id: 'p2', strokes: [], createdAt: 0 },
    { id: 'p3', strokes: [], createdAt: 0 },
  ],
})

beforeEach(() => {
  store.journals.splice(0, store.journals.length, journal())
  store.journalId = 'j1'
  store.pageId = null
  store.view = 'journal'
  store.journalMode = 'fan'
  store.journalSpreadIdx = 0
  store.journalFanPageIdx = 0
  store.journalBookClosed = false
})

describe('JournalView', () => {
  it('renders the WebGL stage without any 2D journal renderer', () => {
    const w = mountJournal()
    expect(w.find('canvas.stage3d').exists()).toBe(true)
    expect(w.find('.fan').exists()).toBe(false)
    expect(w.find('.book').exists()).toBe(false)
    expect(w.find('.closed-cover').exists()).toBe(false)
    expect(w.find('h1').text()).toBe('Field Notes')
    expect(w.find('.count').text()).toContain('3')
  })

  it('changes the 3D journal view and advances the spread counter', async () => {
    const w = mountJournal()
    await w.findAll('.view-modes .icon-btn')[0].trigger('click')
    expect(w.find('.spread-pos').text()).toBe('1 / 3')
    expect(w.findAll('.slot')).toHaveLength(0)
    await w.find('.flip.next').trigger('click')
    expect(w.find('.spread-pos').text()).toBe('2 / 3')
    await w.find('.flip.prev').trigger('click')
    expect(w.find('.spread-pos').text()).toBe('1 / 3')
  })

  it('keeps the final page reachable in an even-length journal', async () => {
    store.journals[0].pages.push({ id: 'p4', strokes: [], createdAt: 0 })
    const w = mountJournal()
    await w.findAll('.view-modes .icon-btn')[0].trigger('click')
    await w.find('.flip.next').trigger('click')
    expect(w.find('.spread-pos').text()).toBe('2 / 3')
    await w.find('.flip.next').trigger('click')
    expect(w.find('.spread-pos').text()).toBe('3 / 3')
    await w.find('.flip.prev').trigger('click')
    expect(w.find('.spread-pos').text()).toBe('2 / 3')
    await w.find('.flip.next').trigger('click')
    expect(w.find('.spread-pos').text()).toBe('3 / 3')
    await w.find('.flip.next').trigger('click')
    expect(w.find('.spread-pos').exists()).toBe(false)
  })

  it('returns from editing to the same spread and page position', async () => {
    store.journals[0].pages.push({ id: 'p4', strokes: [], createdAt: 0 })
    const w = mountJournal()
    await w.findAll('.view-modes .icon-btn')[0].trigger('click')
    await w.find('.flip.next').trigger('click')
    openPage('p3')
    expect(store.view).toBe('canvas')
    w.unmount()

    closeToJournal()
    const returned = mountJournal()
    expect(store.journalMode).toBe('spread')
    expect(store.journalSpreadIdx).toBe(2)
    expect(returned.find('.view-modes .icon-btn').classes()).toContain('on')
    expect(returned.find('.spread-pos').text()).toBe('2 / 3')
  })

  it('returns from editing to fan mode focused on the edited page', async () => {
    const w = mountJournal()
    openPage('p3')
    expect(store.view).toBe('canvas')
    w.unmount()

    closeToJournal()
    const returned = mountJournal()
    expect(store.journalMode).toBe('fan')
    expect(store.journalFanPageIdx).toBe(2)
    expect(returned.findAll('.view-modes .icon-btn')[1].classes()).toContain('on')
  })

  it('closes and reopens the 3D journal using the spread controls', async () => {
    const w = mountJournal()
    await w.findAll('.view-modes .icon-btn')[0].trigger('click')
    await w.find('.flip.prev').trigger('click')
    expect(w.find('.spread-pos').exists()).toBe(false)
    expect(w.find('.flip.next').attributes('aria-label')).toBe('Open journal')
    await w.find('.flip.next').trigger('click')
    expect(w.find('.spread-pos').text()).toBe('1 / 3')
  })

  it('reopens a closed journal with a horizontal swipe on the cover', async () => {
    const w = mountJournal()
    await w.findAll('.view-modes .icon-btn')[0].trigger('click')
    await w.find('.flip.prev').trigger('click')
    const stage = w.find('.stage').element
    const pointer = (type: string, x: number) => {
      const event = new Event(type, { bubbles: true })
      Object.defineProperties(event, {
        pointerId: { value: 1 },
        clientX: { value: x },
        clientY: { value: 120 },
      })
      stage.dispatchEvent(event)
    }

    pointer('pointerdown', 120)
    pointer('pointerup', 210)
    await w.vm.$nextTick()

    expect(w.find('.spread-pos').text()).toBe('1 / 3')
  })

  it('closes the journal at the last spread', async () => {
    const w = mountJournal()
    await w.findAll('.view-modes .icon-btn')[0].trigger('click')
    await w.find('.flip.next').trigger('click')
    expect(w.find('.spread-pos').text()).toBe('2 / 3')
    await w.find('.flip.next').trigger('click')
    expect(w.find('.spread-pos').text()).toBe('3 / 3')
    await w.find('.flip.next').trigger('click')
    expect(w.find('.spread-pos').exists()).toBe(false)
  })

  it('keeps cross-page stroke coordinates intact for the 3D page renderer', () => {
    store.journals[0].pages[0].strokes.push({
      tool: 'draw',
      color: '#22221f',
      pts: [
        { x: 1050, y: 380, t: 0, p: 0.5 },
        { x: 1150, y: 380, t: 16, p: 0.5 },
      ],
    })
    store.journals[0].pages[1].strokes.push({
      tool: 'draw',
      color: '#d9a441',
      pts: [
        { x: 30, y: 420, t: 0, p: 0.5 },
        { x: -100, y: 420, t: 16, p: 0.5 },
      ],
    })

    const w = mountJournal()
    expect(store.journals[0].pages[0].strokes[0].pts[1].x).toBe(1150)
    expect(store.journals[0].pages[1].strokes[0].pts[1].x).toBe(-100)
    expect(w.find('.stage svg').exists()).toBe(false)
  })

  it('renders nothing without a current journal', () => {
    store.journalId = 'missing'
    const w = mountJournal()
    expect(w.find('.journal-view').exists()).toBe(false)
  })

  it('back button returns to the shelf', async () => {
    const w = mountJournal()
    await w.find('.back').trigger('click')
    expect(store.view).toBe('shelf')
    expect(store.journalId).toBeNull()
  })

  it('＋ button adds a page', async () => {
    const w = mountJournal()
    await w.find('footer .round').trigger('click')
    expect(store.journals[0].pages).toHaveLength(4)
    expect(w.find('.count').text()).toContain('4')
  })

  it('does not show a download button in the footer', () => {
    const w = mountJournal()
    expect(w.findAll('footer .round')).toHaveLength(1)
  })

  it('closes the ⋯ menu on an outside click', async () => {
    const w = mountJournal()
    await w.findAll('.right-actions .icon-btn')[1].trigger('click')
    expect(w.find('.menu-pop').exists()).toBe(true)
    await w.find('.menu-shield').trigger('click')
    expect(w.find('.menu-pop').exists()).toBe(false)
    expect(w.find('.menu-shield').exists()).toBe(false)
  })

  it('shows an icon beside each journal menu action', async () => {
    const w = mountJournal()
    await w.findAll('.right-actions .icon-btn')[1].trigger('click')
    const items = w.findAll('.menu-item')
    expect(items).toHaveLength(3)
    expect(items.every((item) => item.find('svg[aria-hidden="true"]').exists())).toBe(true)
  })

  it('requires modal confirmation before deleting a journal', async () => {
    const w = mountJournal()
    await w.findAll('.right-actions .icon-btn')[1].trigger('click')
    await w.find('.menu-item.danger').trigger('click')

    expect(store.journals).toHaveLength(1)
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('Field Notes')
    document.body.querySelector<HTMLButtonElement>('.confirm-cancel')!.click()
    await w.vm.$nextTick()
    expect(store.journals).toHaveLength(1)

    await w.findAll('.right-actions .icon-btn')[1].trigger('click')
    await w.find('.menu-item.danger').trigger('click')
    document.body.querySelector<HTMLButtonElement>('.confirm-delete')!.click()
    await w.vm.$nextTick()
    expect(store.journals).toHaveLength(0)
    expect(store.view).toBe('shelf')
    w.unmount()
  })

})
