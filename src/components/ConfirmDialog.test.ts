import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ConfirmDialog from './ConfirmDialog.vue'
import { i18n } from '../i18n'

describe('ConfirmDialog', () => {
  it('presents an accessible confirmation and emits the selected action', async () => {
    const w = mount(ConfirmDialog, {
      props: { open: true, title: 'Delete page?', message: 'This cannot be undone.' },
      global: { plugins: [i18n] },
    })
    const dialog = document.body.querySelector('[role="dialog"]')!

    expect(dialog.textContent).toContain('Delete page?')
    expect(dialog.textContent).toContain('This cannot be undone.')

    document.body.querySelector<HTMLButtonElement>('.confirm-cancel')!.click()
    expect(w.emitted('cancel')).toHaveLength(1)
    document.body.querySelector<HTMLButtonElement>('.confirm-delete')!.click()
    expect(w.emitted('confirm')).toHaveLength(1)

    w.unmount()
  })

  it('allows cancelling with Escape or the backdrop', async () => {
    const w = mount(ConfirmDialog, {
      props: { open: true, title: 'Delete?', message: 'Confirm?' },
      global: { plugins: [i18n] },
    })

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(w.emitted('cancel')).toHaveLength(1)
    document.body
      .querySelector<HTMLElement>('.mslider-backdrop')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(w.emitted('cancel')).toHaveLength(2)

    w.unmount()
  })
})
