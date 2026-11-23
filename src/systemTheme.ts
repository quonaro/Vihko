import { Capacitor, SystemBars, SystemBarsStyle, SystemBarType } from '@capacitor/core'
import { logger } from './log'

const log = logger('theme')

type Theme = 'light' | 'dark'

/**
 * What the app draws behind the status bar. Android lays the web view out edge
 * to edge, so the bar shows the live content: the theme-based app chrome
 * (shelf, journal) or the always-dark canvas backdrop.
 */
export type BarSurface = 'app' | 'canvas'

const themeStyles = {
  light: SystemBarsStyle.Light,
  dark: SystemBarsStyle.Dark,
} satisfies Record<Theme, SystemBarsStyle>

/** Fallback bar colors — the `theme-color` meta tag for browser chrome. */
const backgroundColors = {
  light: '#f8f7f3',
  dark: '#262628',
} satisfies Record<Theme, string>

export function systemBarStyle(theme: Theme, surface: BarSurface): SystemBarsStyle {
  return surface === 'canvas' ? SystemBarsStyle.Dark : themeStyles[theme]
}

export function systemBarBackground(theme: Theme): string {
  return backgroundColors[theme]
}

export async function syncSystemBarsTheme(
  theme: Theme,
  surface: BarSurface = 'app',
): Promise<void> {
  if (!Capacitor.isNativePlatform()) return
  log.debug('syncing system bars', theme, surface)

  // The status bar sits over the current surface, the navigation bar over the
  // theme-colored chrome (e.g. the tool tray), so they can need different ones.
  await Promise.all([
    SystemBars.setStyle({
      style: systemBarStyle(theme, surface),
      bar: SystemBarType.StatusBar,
    }),
    SystemBars.setStyle({
      style: themeStyles[theme],
      bar: SystemBarType.NavigationBar,
    }),
  ])
}

/** Hides or shows the status bar, e.g. a distraction-free canvas. */
export async function setSystemBarHidden(hidden: boolean): Promise<void> {
  if (!Capacitor.isNativePlatform()) return
  log.debug('status bar hidden', hidden)

  const bar = SystemBarType.StatusBar
  await (hidden ? SystemBars.hide({ bar }) : SystemBars.show({ bar }))
}
