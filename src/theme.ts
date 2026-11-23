import { ref } from 'vue'
import { logger } from './log'
import {
  type BarSurface,
  setSystemBarHidden,
  syncSystemBarsTheme,
  systemBarBackground,
} from './systemTheme'

const log = logger('theme')

export type AppTheme = 'light' | 'dark'

const storageKey = 'vihko:theme'

function readTheme(): AppTheme {
  return localStorage.getItem(storageKey) === 'dark' ? 'dark' : 'light'
}

export const theme = ref<AppTheme>(readTheme())

let surface: BarSurface = 'app'

async function applySystemBars(value: AppTheme) {
  // Show the bar before styling it: showing resets the icon appearance.
  await setSystemBarHidden(surface === 'canvas')
  await syncSystemBarsTheme(value, surface)
}

function applyTheme(value: AppTheme) {
  document.documentElement.dataset.theme = value
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', systemBarBackground(value))
  void applySystemBars(value).catch((error) => log.warn('Could not sync system bar theme', error))
}

applyTheme(theme.value)

export function setTheme(value: AppTheme) {
  log.debug('theme set', value)
  theme.value = value
  localStorage.setItem(storageKey, value)
  applyTheme(value)
}

/**
 * Adapts the system bar to what the app shows: the canvas hides it for a
 * distraction-free editor, and its dark backdrop needs light icons, while the
 * shelf and journal keep the bar over their theme-colored chrome.
 */
export function setSystemBarSurface(next: BarSurface) {
  if (next === surface) return
  surface = next
  void applySystemBars(theme.value).catch((error) =>
    log.warn('Could not sync system bar surface', error),
  )
}
