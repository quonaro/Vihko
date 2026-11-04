import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import JournalView from './JournalView.vue'
import { i18n } from '../i18n'
import { closeToJournal, openPage, store } from '../store'
import { PAGE_SIZE_PRESETS } from '../pageSpace'
import type { Journal } from '../types'

// jsdom has no WebGL, so a fake stands in for JournalScene. It mirrors the
// contract JournalView relies on: `busy` stays true while a turn is in
// flight, `onFlipDone` fires once when the turn completes, and a turn that
// settles back fires nothing. `held` keeps a turn in flight until the test
// calls finish()/cancel(), like a drag or animation still in progress.
const mocks = vi.hoisted(() => ({
  scenes: [] as {
    busy: boolean
    held: boolean
    events: {
      onFlipDone?: (dir: 1 | -1) => void
      onHoverPage?: (id: string | null, anchor?: { x: number; y: number }) => void
      onSheetAnchors?: (list: { id: string; x: number; y: number }[]) => void
    }
    flip(dir: 1 | -1): boolean
    finish(): void
    cancel(): void
  }[],
}))

vi.mock('../three/journalScene', () => ({
  JournalScene: class {
    busy = false
    held = false
    private dir: 1 | -1 = 1
    readonly ready = Promise.resolve()
    constructor(
      _canvas: HTMLCanvasElement,
      _ink: unknown,
      public events: {
        onFlipDone?: (dir: 1 | -1) => void
        onHoverPage?: (id: string | null, anchor?: { x: number; y: number }) => void
        onSheetAnchors?: (list: { id: string; x: number; y: number }[]) => void
      },
    ) {
      mocks.scenes.push(this)
    }
    setMode() {}
    setPages() {}
    setPage() {}
    setOverviewFocus() {}
    start() {}
    dispose() {}
    flip(dir: 1 | -1): boolean {
      if (this.busy) return false
      this.busy = true
      this.dir = dir
      if (!this.held) this.finish()
      return true
    }
    finish() {
      if (!this.busy) return
      this.busy = false
      this.events.onFlipDone?.(this.dir)
    }
    cancel() {
      this.busy = false
    }
  },
}))

const mountJournal = () => mount(JournalView, { global: { plugins: [i18n] } })

const journal = (): Journal => ({
  id: 'j1',
  title: 'Field Notes',
  cover: 2,
  createdAt: 0,
  pages: [
    { id: 'p1', strokes: [], createdAt: 0 },
    { id: 'p2', strokes: [], createdAt: 0 },
    { id: 'p3', strokes: [], createdAt: 0 },
  ],
})

beforeEach(() => {
  mocks.scenes.length = 0
  store.journals.splice(0, store.journals.length, journal())
  store.journalId = 'j1'
  store.pageId = null
  store.view = 'journal'
  store.journalMode = 'stack'
  store.journalPageIdx = 0
  store.journalOverviewIdx = 0
  store.pageSize = 'spread'
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

  it('switches between stack and overview and advances the page counter', async () => {
    const w = mountJournal()
    expect(w.find('.page-number').text()).toBe('1 / 3')
    await w.find('.flip.next').trigger('click')
    expect(w.find('.page-number').text()).toBe('2 / 3')
    await w.find('.flip.prev').trigger('click')
    expect(w.find('.page-number').text()).toBe('1 / 3')
    await w.findAll('.view-modes .icon-btn')[1].trigger('click')
    expect(w.find('.page-pos').exists()).toBe(false)
    expect(w.find('.flip.next').exists()).toBe(false)
    await w.findAll('.view-modes .icon-btn')[0].trigger('click')
    expect(w.find('.page-number').text()).toBe('1 / 3')
  })

  it('shows the size type of the currently selected page beside its counter', async () => {
    const portrait = PAGE_SIZE_PRESETS.find((preset) => preset.id === 'portrait')!
    store.journals[0].pages[1].w = portrait.w
    store.journals[0].pages[1].h = portrait.h
    const w = mountJournal()

    expect(w.find('.page-kind').text()).toContain(i18n.global.t('journal.size.spread'))
    await w.find('.flip.next').trigger('click')
    expect(w.find('.page-number').text()).toBe('2 / 3')
    expect(w.find('.page-kind').text()).toContain(i18n.global.t('journal.size.portrait'))
  })

  it('chooses the new page size from a custom modal selector', async () => {
    const w = mountJournal()

    await w.find('.page-size').trigger('click')
    const options = document.body.querySelectorAll<HTMLButtonElement>('.page-size-option')
    expect(options).toHaveLength(PAGE_SIZE_PRESETS.length)
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()

    options[2].click()
    await flushPromises()

    expect(store.pageSize).toBe('square')
    expect(w.find('.page-size').text()).toContain(i18n.global.t('journal.size.square'))
    expect(document.body.querySelector('.page-size-option')).toBeNull()
  })

  it('uses the selected size for the next page', async () => {
    const w = mountJournal()

    await w.find('.page-size').trigger('click')
    document.body.querySelectorAll<HTMLButtonElement>('.page-size-option')[1].click()
    await flushPromises()
    await w.find('.round').trigger('click')

    const portrait = PAGE_SIZE_PRESETS.find((preset) => preset.id === 'portrait')!
    expect(store.journals[0].pages.at(-1)).toMatchObject({ w: portrait.w, h: portrait.h })
  })

  it('keeps the last page reachable and stops turning at the stack ends', async () => {
    store.journals[0].pages.push({ id: 'p4', strokes: [], createdAt: 0 })
    const w = mountJournal()
    expect(w.find('.flip.prev').attributes('disabled')).toBeDefined()
    await w.find('.flip.next').trigger('click')
    expect(w.find('.page-number').text()).toBe('2 / 4')
    await w.find('.flip.next').trigger('click')
    expect(w.find('.page-number').text()).toBe('3 / 4')
    await w.find('.flip.next').trigger('click')
    expect(w.find('.page-number').text()).toBe('4 / 4')
    expect(w.find('.flip.next').attributes('disabled')).toBeDefined()
    await w.find('.flip.prev').trigger('click')
    expect(w.find('.page-number').text()).toBe('3 / 4')
  })

  it('returns from editing to the overview focused on the edited page', async () => {
    store.journals[0].pages.push({ id: 'p4', strokes: [], createdAt: 0 })
    const w = mountJournal()
    await w.findAll('.view-modes .icon-btn')[1].trigger('click')
    openPage('p3')
    expect(store.view).toBe('canvas')
    w.unmount()

    closeToJournal()
    const returned = mountJournal()
    expect(store.journalMode).toBe('overview')
    expect(store.journalOverviewIdx).toBe(2)
    expect(returned.findAll('.view-modes .icon-btn')[1].classes()).toContain('on')
  })

  it('returns from editing to the stack focused on the edited page', async () => {
    const w = mountJournal()
    openPage('p3')
    expect(store.view).toBe('canvas')
    w.unmount()

    closeToJournal()
    const returned = mountJournal()
    expect(store.journalMode).toBe('stack')
    expect(store.journalPageIdx).toBe(2)
    expect(returned.findAll('.view-modes .icon-btn')[0].classes()).toContain('on')
    expect(returned.find('.page-number').text()).toBe('3 / 3')
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

  // The scene is only constructed for a canvas attached to the document, so
  // these mount into the body to exercise the real busy/onFlipDone wiring.
  describe('page delete button', () => {
    const mountAttached = async () => {
      const w = mount(JournalView, {
        attachTo: document.body,
        global: { plugins: [i18n] },
      })
      await flushPromises()
      return w
    }

    it('is shown on hover when the journal has more than one page', async () => {
      const w = await mountAttached()
      mocks.scenes[0].events.onHoverPage?.('p1', { x: 10, y: 10 })
      await w.vm.$nextTick()
      expect(w.find('.del.gl-del').exists()).toBe(true)
      w.unmount()
    })

    it('is hidden when the journal has a single page', async () => {
      store.journals[0].pages.splice(1)
      const w = await mountAttached()
      mocks.scenes[0].events.onHoverPage?.('p1', { x: 10, y: 10 })
      await w.vm.$nextTick()
      expect(w.find('.del.gl-del').exists()).toBe(false)
      w.unmount()
    })
  })
  describe('page counter while a scene turn is in flight', () => {
    const mountAttached = async () => {
      const w = mount(JournalView, {
        attachTo: document.body,
        global: { plugins: [i18n] },
      })
      await flushPromises()
      return w
    }

    it('ignores repeated flip clicks while a turn is in flight', async () => {
      const w = await mountAttached()
      const scene = mocks.scenes[0]
      scene.held = true

      await w.find('.flip.next').trigger('click')
      expect(scene.busy).toBe(true)
      await w.find('.flip.next').trigger('click')
      await w.find('.flip.next').trigger('click')
      expect(w.find('.page-number').text()).toBe('1 / 3')

      scene.finish()
      await w.vm.$nextTick()
      expect(w.find('.page-number').text()).toBe('2 / 3')
      w.unmount()
    })

    it('advances the counter exactly once when the turn completes', async () => {
      const w = await mountAttached()
      await w.find('.flip.next').trigger('click')
      expect(w.find('.page-number').text()).toBe('2 / 3')
      await w.find('.flip.next').trigger('click')
      expect(w.find('.page-number').text()).toBe('3 / 3')
      w.unmount()
    })

    it('does not advance the counter when the turn settles back', async () => {
      const w = await mountAttached()
      const scene = mocks.scenes[0]
      scene.held = true

      await w.find('.flip.next').trigger('click')
      scene.cancel()
      await w.vm.$nextTick()
      expect(w.find('.page-number').text()).toBe('1 / 3')

      scene.held = false
      await w.find('.flip.next').trigger('click')
      expect(w.find('.page-number').text()).toBe('2 / 3')
      w.unmount()
    })
  })
})
