import { ref } from 'vue'
import { logger } from './log'
import { getSystemBarSettings, syncSystemBarsTheme } from './systemTheme'

const log = logger('theme')

export type AppTheme = 'light' | 'dark'

const storageKey = 'vihko:theme'

function readTheme(): AppTheme {
  return localStorage.getItem(storageKey) === 'dark' ? 'dark' : 'light'
}

export const theme = ref<AppTheme>(readTheme())

function applyTheme(value: AppTheme) {
  document.documentElement.dataset.theme = value
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', getSystemBarSettings(value).backgroundColor)
  void syncSystemBarsTheme(value).catch((error) =>
    log.warn('Could not sync system bar theme', error),
  )
}

applyTheme(theme.value)

export function setTheme(value: AppTheme) {
  log.debug('theme set', value)
  theme.value = value
  localStorage.setItem(storageKey, value)
  applyTheme(value)
}
