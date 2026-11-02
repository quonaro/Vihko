import {
  Capacitor,
  registerPlugin,
  SystemBars,
  SystemBarsStyle,
  SystemBarType,
} from '@capacitor/core'

type Theme = 'light' | 'dark'

interface ThemeStatusBarPlugin {
  setBackgroundColor(options: { color: string }): Promise<void>
}

const ThemeStatusBar = registerPlugin<ThemeStatusBarPlugin>('ThemeStatusBar')

const systemBarSettings = {
  light: {
    style: SystemBarsStyle.Light,
    backgroundColor: '#f8f7f3',
  },
  dark: {
    style: SystemBarsStyle.Dark,
    backgroundColor: '#262628',
  },
} satisfies Record<Theme, { style: SystemBarsStyle; backgroundColor: string }>

export function getSystemBarSettings(theme: Theme) {
  return systemBarSettings[theme]
}

export async function syncSystemBarsTheme(theme: Theme) {
  if (!Capacitor.isNativePlatform()) return

  const settings = getSystemBarSettings(theme)
  await SystemBars.setStyle({
    style: settings.style,
    bar: SystemBarType.StatusBar,
  })

  if (Capacitor.getPlatform() === 'android') {
    await ThemeStatusBar.setBackgroundColor({ color: settings.backgroundColor })
  }
}
