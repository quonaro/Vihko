import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import MobileSlider from './MobileSlider.vue'
import PromptDialog from './PromptDialog.vue'
import { usePrompt } from '../composables/usePrompt'
import { i18n } from '../i18n'

const plugins = { global: { plugins: [i18n] } }
const dialog = () => document.body.querySelector('[role="dialog"]')

let wrappers: VueWrapper[] = []
const track = <T extends VueWrapper>(w: T): T => (wrappers.push(w), w)

beforeEach(() => {
  document.documentElement.style.overflow = ''
})

afterEach(() => {
  wrappers.forEach((w) => w.unmount())
  wrappers = []
  document.documentElement.style.overflow = ''
})

describe('MobileSlider', () => {
  it('teleports a dialog into body only while open', async () => {
    const w = track(mount(MobileSlider, {
      ...plugins,
      props: { open: false, title: 'Sheet' },
    }))
    expect(dialog()).toBeNull()
    await w.setProps({ open: true })
    expect(dialog()?.textContent).toContain('Sheet')
  })

  it('locks document scroll while open and restores on unmount', async () => {
    const w = track(mount(MobileSlider, {
      ...plugins,
      props: { open: true, title: 'T' },
    }))
    expect(document.documentElement.style.overflow).toBe('hidden')
    await w.setProps({ open: false })
    expect(document.documentElement.style.overflow).toBe('')
  })

  it('emits close on backdrop click, close button and Escape', async () => {
    const w = track(mount(MobileSlider, {
      ...plugins,
      props: { open: true, title: 'T' },
    }))
    const backdrop = document.body.querySelector('.mslider-backdrop') as HTMLElement
    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(w.emitted('update:open')?.[0]).toEqual([false])
    expect(w.emitted('close')).toHaveLength(1)

    await w.setProps({ open: true })
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(w.emitted('update:open')?.[1]).toEqual([false])

    await w.setProps({ open: true })
    const btn = document.body.querySelector('.mslider-head .close') as HTMLElement
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(w.emitted('update:open')?.[2]).toEqual([false])
  })

  it('hides the scrollbar on the body when no-scrollbar is set', async () => {
    track(mount(MobileSlider, {
      ...plugins,
      props: { open: true, title: 'T', noScrollbar: true },
    }))
    expect(document.body.querySelector('.mslider-body')?.classList).toContain('no-scrollbar')
  })
})

describe('PromptDialog', () => {
  it('shows prompt state and settles the entered value on submit', async () => {
    track(mount(PromptDialog, plugins))
    const { state, prompt } = usePrompt()
    const p = prompt({ title: 'Journal title', value: 'Old' })
    await nextTick()
    expect(dialog()?.textContent).toContain('Journal title')
    const input = document.body.querySelector<HTMLInputElement>('.dlg-input')!
    expect(input.value).toBe('Old')
    input.value = 'New title'
    input.dispatchEvent(new Event('input'))
    await nextTick()
    const buttons = [...document.body.querySelectorAll<HTMLButtonElement>('.dlg-btn')]
    buttons.find((b) => !b.disabled && b.classList.contains('primary'))!.click()
    await expect(p).resolves.toBe('New title')
    expect(state.open).toBe(false)
  })

  it('resolves null when dismissed', async () => {
    track(mount(PromptDialog, plugins))
    const { prompt } = usePrompt()
    const p = prompt({ title: 'T', inputMode: 'numeric' })
    await nextTick()
    const input = document.body.querySelector<HTMLInputElement>('.dlg-input')!
    expect(input.getAttribute('inputmode')).toBe('numeric')
    const cancel = document.body.querySelector<HTMLButtonElement>('.dlg-btn')!
    cancel.click()
    await expect(p).resolves.toBeNull()
  })
})
