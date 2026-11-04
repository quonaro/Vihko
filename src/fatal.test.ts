import { describe, expect, it } from 'vitest'
import { showFatalError } from './fatal'
import { i18n, setLocale } from './i18n'

describe('showFatalError', () => {
  it('renders an empty state with icon and localized message', () => {
    setLocale('en')
    const root = document.createElement('div')
    showFatalError(root)
    expect(root.querySelector('.fatal')).not.toBeNull()
    expect(root.querySelector('.fatal-icon')).not.toBeNull()
    expect(root.querySelector('.fatal-title')?.textContent).toBe(i18n.global.t('fatal.title'))
    expect(root.querySelector('.fatal-hint')?.textContent).toBe(i18n.global.t('fatal.hint'))
  })

  it('localizes the message', () => {
    setLocale('ru')
    const root = document.createElement('div')
    showFatalError(root)
    expect(root.querySelector('.fatal-title')?.textContent).toBe(
      'Не удалось открыть локальную базу данных',
    )
    setLocale('en')
  })
})
