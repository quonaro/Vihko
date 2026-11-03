import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import EmptyState from './EmptyState.vue'

describe('EmptyState', () => {
  it('renders the title, hint and icon slot as a status', () => {
    const w = mount(EmptyState, {
      props: { title: 'No journals yet', hint: 'Tap + to create one' },
      slots: { icon: '<svg class="ic" />' },
    })

    expect(w.attributes('role')).toBe('status')
    expect(w.find('.empty-title').text()).toBe('No journals yet')
    expect(w.find('.empty-hint').text()).toBe('Tap + to create one')
    expect(w.find('.empty-icon svg.ic').exists()).toBe(true)
  })

  it('omits the hint and icon wrappers when not provided', () => {
    const w = mount(EmptyState, { props: { title: 'Empty' } })

    expect(w.find('.empty-title').text()).toBe('Empty')
    expect(w.find('.empty-hint').exists()).toBe(false)
    expect(w.find('.empty-icon').exists()).toBe(false)
  })
})
