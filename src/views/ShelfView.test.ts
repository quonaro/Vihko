import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import ShelfView from './ShelfView.vue'
import { usePrompt } from '../composables/usePrompt'
import { i18n, setLocale } from '../i18n'
import { store } from '../store'
import { setTheme } from '../theme'
import { update } from '../update'
import { setGlQuality, setCoverQuality } from '../quality'
import type { Journal } from '../types'

const shelfSceneMock = vi.hoisted(() => ({
  events: null as { onLongPress?: (id: string) => void } | null,
}))

// The real shelf needs WebGL; the fake scene emits fixed anchors and exposes
// its long-press callback so the management sheet can be tested.
vi.mock('../three/shelfScene', () => ({
  ShelfScene: class {
    private journals: { id: string }[] = []
    constructor(
      _canvas: HTMLCanvasElement,
      private events: {
        onOverlay?: (anchors: unknown[]) => void
        onLongPress?: (id: string) => void
      },
    ) {
      shelfSceneMock.events = this.events
    }
    setJournals(list: { id: string }[]) {
      this.journals = list
    }
    start() {
      this.events.onOverlay?.(
        this.journals.map((j, i) => ({
          id: j.id,
          onScreen: true,
          label: { x: 60 + i * 80, y: 160 },
          title: { x: 60 + i * 80, y: 180 },
        })),
      )
    }
    dispose() {}
    longPress(id: string) {
      this.events.onLongPress?.(id)
    }
    screenRect() {
      return null
    }
  },
}))

const mountShelf = () => mount(ShelfView, { global: { plugins: [i18n] } })

const journal = (id: string, title: string): Journal => ({
  id,
  title,
  cover: 0,
  createdAt: 0,
  pages: [{ id: `${id}-p1`, strokes: [], createdAt: 0 }],
})

beforeEach(() => {
  shelfSceneMock.events = null
  store.journals.splice(0, store.journals.length, journal('a', 'Alpha'), journal('b', 'Beta'))
  store.journalId = null
  store.pageId = null
  store.view = 'shelf'
  setLocale('en')
  setTheme('light')
  update.status = 'idle'
  update.busy = false
  update.latest = ''
  update.apkUrl = ''
  update.dl = 'idle'
  update.progress = 0
  update.apkPath = ''
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  usePrompt().settle(null)
  setTheme('light')
  localStorage.removeItem('vihko:theme')
  setGlQuality('medium')
  setCoverQuality('medium')
  localStorage.removeItem('vihko:gl-quality')
  localStorage.removeItem('vihko:cover-quality')
  document.querySelectorAll('.morph').forEach((el) => {
    el.remove()
  })
  document.querySelectorAll('.mslider-backdrop').forEach((el) => {
    el.remove()
  })
})

describe('ShelfView', () => {
  it('renders a WebGL-only shelf without DOM book cards', () => {
    const w = mountShelf()
    expect(w.find('canvas.shelf3d').exists()).toBe(true)
    expect(w.findAll('.book')).toHaveLength(0)
    expect(w.findAll('.book-inner')).toHaveLength(0)
  })

  it('shows the journal count in the header', () => {
    const w = mountShelf()
    expect(w.find('.count').text()).toContain('2')
  })

  it('uses a sliders icon for shelf settings', () => {
    const w = mountShelf()
    const button = w.find('.settings-btn')
    expect(button.attributes('aria-label')).toBe('Settings')
    expect(button.find('svg').exists()).toBe(true)
    expect(button.text()).toBe('')
  })

  it('＋ button adds a journal', async () => {
    const w = mountShelf()
    await w.find('footer .round').trigger('click')
    expect(store.journals).toHaveLength(3)
  })

  it('shows theme, language, version and updates in the settings sheet', async () => {
    const w = mountShelf()
    await w.findAll('.top-actions .icon-btn')[1].trigger('click')
    // the settings sheet is teleported to <body>
    const rows = document.body.querySelectorAll<HTMLElement>('.set-row')
    expect(rows).toHaveLength(6)
    expect(rows[0].querySelector('.set-value')?.textContent?.trim()).toMatch(/^v\d+\.\d+\.\d+/)
    expect(rows[5].querySelector<HTMLButtonElement>('.set-action')?.textContent).toBe(
      'Check for updates',
    )
    expect(document.body.textContent).not.toContain('2D')
  })

  it('checks for updates from the settings sheet', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            json: async () => ({ tag_name: 'v99.0.0', html_url: 'https://example.com/rel' }),
          }) as Response,
      ),
    )
    const w = mountShelf()
    await w.findAll('.top-actions .icon-btn')[1].trigger('click')
    const btn = document.body.querySelector<HTMLButtonElement>('.set-action')!
    btn.click()
    await flushPromises()
    const status = document.body.querySelector<HTMLElement>('.set-value')!
    expect(status.textContent?.trim()).toMatch(/^v\d+\.\d+\.\d+$/)
    expect(btn.textContent).toBe('Update v99.0.0')
    expect(w.find('.update-dot').exists()).toBe(true)
    const banner = w.find('button.update-banner')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toContain('99.0.0')
    vi.unstubAllGlobals()
  })

  it('switches the language from the settings sheet', async () => {
    const w = mountShelf()
    await w.findAll('.top-actions .icon-btn')[1].trigger('click')
    const rows = document.body.querySelectorAll<HTMLElement>('.set-row')
    const seg = rows[2].querySelectorAll<HTMLElement>('.seg-btn')
    expect(seg[0].textContent).toBe('English')
    expect(seg[1].textContent).toBe('Русский')
    expect(seg[0].classList.contains('on')).toBe(true)
    seg[1].click()
    await nextTick()
    expect(i18n.global.locale.value).toBe('ru')
    expect(localStorage.getItem('vihko:locale')).toBe('ru')
    expect(seg[1].classList.contains('on')).toBe(true)
    seg[0].click()
    await nextTick()
    expect(i18n.global.locale.value).toBe('en')
  })

  it('switches and persists the appearance theme from settings', async () => {
    const w = mountShelf()
    await w.findAll('.top-actions .icon-btn')[1].trigger('click')
    const buttons = document.body
      .querySelectorAll<HTMLElement>('.set-row')[1]
      .querySelectorAll<HTMLButtonElement>('.seg-btn')

    expect(buttons[0].getAttribute('aria-pressed')).toBe('true')
    buttons[1].click()
    await nextTick()

    expect(buttons[1].getAttribute('aria-pressed')).toBe('true')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(localStorage.getItem('vihko:theme')).toBe('dark')
  })

  it('switches and persists render and cover quality from settings', async () => {
    const w = mountShelf()
    await w.findAll('.top-actions .icon-btn')[1].trigger('click')
    const rows = document.body.querySelectorAll<HTMLElement>('.set-row')
    const renderSeg = rows[3].querySelectorAll<HTMLButtonElement>('.seg-btn')
    const coverSeg = rows[4].querySelectorAll<HTMLButtonElement>('.seg-btn')
    expect(renderSeg).toHaveLength(4)
    expect(coverSeg).toHaveLength(4)

    expect(renderSeg[1].classList.contains('on')).toBe(true) // medium default
    expect(coverSeg[1].classList.contains('on')).toBe(true)

    renderSeg[3].click() // ultra
    coverSeg[0].click() // low
    await nextTick()

    expect(localStorage.getItem('vihko:gl-quality')).toBe('ultra')
    expect(localStorage.getItem('vihko:cover-quality')).toBe('low')
    expect(renderSeg[3].classList.contains('on')).toBe(true)
    expect(coverSeg[0].classList.contains('on')).toBe(true)
  })

  it('opens a search modal listing all journals', async () => {
    const w = mountShelf()
    await w.find('.search-btn').trigger('click')
    // the search sheet is teleported to <body>
    const hits = document.body.querySelectorAll('.search-hit')
    expect(hits).toHaveLength(2)
    expect(hits[0].textContent).toContain('Alpha')
    expect(hits[1].textContent).toContain('Beta')
  })

  it('filters results by the query and opens the picked journal', async () => {
    const w = mountShelf()
    await w.find('.search-btn').trigger('click')
    const input = document.body.querySelector<HTMLInputElement>('.search-input')!
    input.value = 'bet'
    input.dispatchEvent(new Event('input'))
    await nextTick()
    const hits = document.body.querySelectorAll<HTMLElement>('.search-hit')
    expect(hits).toHaveLength(1)
    expect(hits[0].textContent).toContain('Beta')
    hits[0].click()
    await nextTick()
    expect(store.journalId).toBe('b')
    expect(store.view).toBe('journal')
    expect(document.body.querySelector('.search-input')).toBeNull()
  })

  it('replaces the journal overlay buttons with a long-press action sheet', async () => {
    const w = mount(ShelfView, { global: { plugins: [i18n] }, attachTo: document.body })
    await flushPromises()
    expect(w.find('.store-link').exists()).toBe(false)
    expect(w.findAll('.gl-del')).toHaveLength(0)
    expect(w.findAll('.gl-sel')).toHaveLength(0)
    shelfSceneMock.events?.onLongPress?.('a')
    await nextTick()
    expect(document.body.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Alpha')
    expect(document.body.querySelectorAll('.journal-action')).toHaveLength(5)
    expect(document.body.textContent).toContain('Rename journal')
    expect(document.body.textContent).toContain('Export journal (JSON)')

    const deleteButton = [
      ...document.body.querySelectorAll<HTMLButtonElement>('.journal-action'),
    ].find((button) => button.textContent?.includes('Delete journal'))!
    deleteButton.click()
    await nextTick()
    expect(document.body.textContent).toContain('Delete "Alpha" and all its pages?')
    expect(document.body.querySelector('.confirm-delete')).toBeTruthy()
  })

  it('lets each journal choose a paper, smooth, or comic cover texture', async () => {
    const w = mount(ShelfView, { global: { plugins: [i18n] }, attachTo: document.body })
    await flushPromises()
    shelfSceneMock.events?.onLongPress?.('a')
    await nextTick()

    const textureBtn = [
      ...document.body.querySelectorAll<HTMLButtonElement>('.journal-action'),
    ].find((button) => button.textContent?.includes('Change cover texture'))!
    textureBtn.click()
    await nextTick()

    const options = document.body.querySelectorAll<HTMLButtonElement>('.texture-option')
    expect(options).toHaveLength(3)
    expect(options[0].getAttribute('aria-pressed')).toBe('true')
    expect(options[0].textContent).toContain('Paper (current)')
    expect(options[1].textContent).toContain('Smooth')
    expect(options[2].textContent).toContain('Comic')

    options[2].click()
    await flushPromises()
    expect(store.journals[0].coverTexture).toBe('comic')
    expect(document.body.querySelector('.texture-option')).toBeNull()
    w.unmount()
  })

  it('opens the cover picker from the journal action sheet and applies a preset cover', async () => {
    // attachTo: the scene setup bails unless the canvas is connected.
    const w = mount(ShelfView, { global: { plugins: [i18n] }, attachTo: document.body })
    await flushPromises()
    shelfSceneMock.events?.onLongPress?.('a')
    await nextTick()

    const coverBtn = [...document.body.querySelectorAll<HTMLButtonElement>('.journal-action')].find(
      (button) => button.textContent?.includes('Change cover'),
    )!
    coverBtn.click()
    await nextTick()

    // the cover sheet is teleported to <body>
    expect(document.body.querySelector('.mslider-body')?.classList).toContain('no-scrollbar')
    const options = document.body.querySelectorAll<HTMLElement>('.cover-option')
    expect(options.length).toBeGreaterThan(1)
    options[0].click()
    await flushPromises()
    expect(store.journals[0].coverImg).toBeTruthy()
    expect(document.body.querySelector('.cover-option')).toBeNull()

    shelfSceneMock.events?.onLongPress?.('a')
    await nextTick()
    const changeCover = [
      ...document.body.querySelectorAll<HTMLButtonElement>('.journal-action'),
    ].find((button) => button.textContent?.includes('Change cover'))!
    changeCover.click()
    await nextTick()

    const removeCover = document.body.querySelector<HTMLButtonElement>('.remove-cover')!
    expect(removeCover.textContent?.trim()).toBe('')
    expect(removeCover.getAttribute('aria-label')).toBe('Remove photo cover')
    expect(removeCover.querySelector('svg')).not.toBeNull()
    removeCover.click()
    await flushPromises()
    expect(store.journals[0].coverImg).toBeUndefined()
    w.unmount()
  })

  it('shows a centered empty state when there are no journals', async () => {
    store.journals.splice(0)
    const w = mountShelf()
    await flushPromises()
    const empty = w.find('.shelf-empty')
    expect(empty.exists()).toBe(true)
    expect(empty.find('.empty-icon svg').exists()).toBe(true)
    expect(empty.text()).toContain('No journals yet')
  })

  it('shows an empty state in the modal when nothing matches', async () => {
    const w = mountShelf()
    await w.find('.search-btn').trigger('click')
    const input = document.body.querySelector<HTMLInputElement>('.search-input')!
    input.value = 'zzz'
    input.dispatchEvent(new Event('input'))
    await nextTick()
    expect(document.body.querySelectorAll('.search-hit')).toHaveLength(0)
    expect(document.body.querySelector('.search-none')).toBeTruthy()
  })
})
