import { describe, expect, it } from 'vitest'

import { usePrompt } from './usePrompt'

describe('usePrompt', () => {
  it('applies defaults and resolves the entered value', async () => {
    const { state, prompt, settle } = usePrompt()
    const p = prompt({ title: 'Journal title' })
    expect(state.open).toBe(true)
    expect(state.title).toBe('Journal title')
    expect(state.value).toBe('')
    expect(state.inputMode).toBe('text')
    expect(state.confirmText).toBeTruthy()
    expect(state.cancelText).toBeTruthy()
    state.value = 'Field Notes'
    settle(state.value)
    await expect(p).resolves.toBe('Field Notes')
    expect(state.open).toBe(false)
  })

  it('prefills value/placeholder/inputMode and resolves null on cancel', async () => {
    const { state, prompt, settle } = usePrompt()
    const p = prompt({ title: 't', value: '3', placeholder: 'Page number', inputMode: 'numeric' })
    expect(state.value).toBe('3')
    expect(state.placeholder).toBe('Page number')
    expect(state.inputMode).toBe('numeric')
    settle(null)
    await expect(p).resolves.toBeNull()
  })

  it('a second prompt resolves the previous one with null', async () => {
    const { prompt, settle } = usePrompt()
    const first = prompt({ title: 'one' })
    const second = prompt({ title: 'two' })
    await expect(first).resolves.toBeNull()
    settle('v')
    await expect(second).resolves.toBe('v')
  })
})
