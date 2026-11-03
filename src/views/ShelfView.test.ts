import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import ShelfView from './ShelfView.vue'
import { usePrompt } from '../composables/usePrompt'
import { i18n, setLocale } from '../i18n'
import { store } from '../store'
import { setTheme } from '../theme'
import { update } from '../update'
import type { Journal } from '../types'

// The real shelf needs WebGL; the fake scene emits fixed anchors so the
// overlay ⋮/× buttons render and a journal can be selected in tests.
vi.mock('../three/shelfScene', () => ({
  ShelfScene: class {
    private journals: { id: string }[] = []
    constructor(
      _canvas: HTMLCanvasElement,
      private events: { onOverlay?: (anchors: unknown[]) => void },
    ) {}
    setJournals(list: { id: string }[]) {
      this.journals = list
    }
    setSelected() {}
    start() {
      this.events.onOverlay?.(
        this.journals.map((j, i) => ({
          id: j.id,
          onScreen: true,
          hover: i === 0,
          del: { x: 60 + i * 80, y: 60 },
          sel: { x: 60 + i * 80, y: 120 },
          actions: { x: 60 + i * 80, y: 120 },
          label: { x: 60 + i * 80, y: 160 },
        })),
      )
    }
    dispose() {}
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
    expect(rows).toHaveLength(4)
    expect(rows[0].querySelector('.set-value')?.textContent?.trim()).toMatch(/^v\d+\.\d+\.\d+/)
    expect(rows[3].querySelector<HTMLButtonElement>('.set-action')?.textContent).toBe(
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

  it('has no store button; the cover button only shows for a selected journal', async () => {
    const w = mountShelf()
    await flushPromises()
    expect(w.find('.store-link').exists()).toBe(false)
    expect(w.find('footer .cover-btn').exists()).toBe(false)
  })

  it('opens the cover picker from the footer and applies a preset cover', async () => {
    // attachTo: the scene setup bails unless the canvas is connected.
    const w = mount(ShelfView, { global: { plugins: [i18n] }, attachTo: document.body })
    await flushPromises()
    await w.find('.gl-sel').trigger('click')
    await nextTick()

    const coverBtn = w.find('footer .cover-btn')
    expect(coverBtn.exists()).toBe(true)
    await coverBtn.trigger('click')
    await nextTick()

    // the cover sheet is teleported to <body>
    expect(document.body.querySelector('.mslider-body')?.classList).toContain('no-scrollbar')
    const options = document.body.querySelectorAll<HTMLElement>('.cover-option')
    expect(options.length).toBeGreaterThan(1)
    options[0].click()
    await flushPromises()
    expect(store.journals[0].coverImg).toBeTruthy()
    expect(document.body.querySelector('.cover-option')).toBeNull()
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
