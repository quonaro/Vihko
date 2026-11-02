import { ref } from 'vue'
import { syncSystemBarsTheme } from './systemTheme'

export type AppTheme = 'light' | 'dark'

const storageKey = 'vihko:theme'

function readTheme(): AppTheme {
  return localStorage.getItem(storageKey) === 'dark' ? 'dark' : 'light'
}

export const theme = ref<AppTheme>(readTheme())

function applyTheme(value: AppTheme) {
  document.documentElement.dataset.theme = value
  void syncSystemBarsTheme(value).catch((error) =>
    console.warn('Could not sync system bar theme', error),
  )
}

applyTheme(theme.value)

export function setTheme(value: AppTheme) {
  theme.value = value
  localStorage.setItem(storageKey, value)
  applyTheme(value)
}
