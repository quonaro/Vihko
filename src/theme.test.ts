import { afterEach, describe, expect, it, vi } from 'vitest'
import { setTheme, theme } from './theme'

afterEach(() => {
  setTheme('light')
  localStorage.removeItem('vihko:theme')
})

describe('theme', () => {
  it('applies and persists the selected theme', () => {
    setTheme('dark')

    expect(theme.value).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(localStorage.getItem('vihko:theme')).toBe('dark')
  })

  it('switches back to the light theme', () => {
    setTheme('dark')
    setTheme('light')

    expect(theme.value).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(localStorage.getItem('vihko:theme')).toBe('light')
  })

  it('keeps the theme-color meta tag in sync', () => {
    const meta = document.createElement('meta')
    meta.name = 'theme-color'
    document.head.appendChild(meta)

    setTheme('dark')
    expect(meta.getAttribute('content')).toBe('#262628')
    setTheme('light')
    expect(meta.getAttribute('content')).toBe('#f8f7f3')

    meta.remove()
  })

  it('restores the saved theme when the app starts', async () => {
    localStorage.setItem('vihko:theme', 'dark')
    vi.resetModules()
    const freshTheme = await import('./theme')

    expect(freshTheme.theme.value).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
  })
})
