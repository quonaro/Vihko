import { describe, it, expect, vi } from 'vitest'
import { i18n, setLocale } from './i18n'

describe('i18n', () => {
  it('translates known keys', () => {
    setLocale('en')
    expect(i18n.global.t('shelf.title')).toBe('Journals')
    expect(i18n.global.t('tool.draw')).toBe('Draw')
  })

  it('interpolates named params', () => {
    setLocale('en')
    expect(i18n.global.t('names.journal', { n: 5 })).toBe('Journal 5')
  })

  it('setLocale switches messages and persists the choice', () => {
    setLocale('ru')
    expect(i18n.global.locale.value).toBe('ru')
    expect(i18n.global.t('shelf.title')).toBe('Блокноты')
    expect(localStorage.getItem('vihko:locale')).toBe('ru')
    setLocale('en')
  })

  it('picks the initial locale from storage', async () => {
    localStorage.setItem('vihko:locale', 'ru')
    vi.resetModules()
    const { i18n: fresh } = await import('./i18n')
    expect(fresh.global.locale.value).toBe('ru')
    localStorage.removeItem('vihko:locale')
  })
})
