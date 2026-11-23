import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  getPlatform: vi.fn(() => 'android'),
  isNativePlatform: vi.fn(() => true),
  setStyle: vi.fn(async () => {}),
  hide: vi.fn(async () => {}),
  show: vi.fn(async () => {}),
}))

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: native.getPlatform,
    isNativePlatform: native.isNativePlatform,
  },
  SystemBars: {
    setStyle: native.setStyle,
    hide: native.hide,
    show: native.show,
  },
  SystemBarsStyle: { Dark: 'DARK', Light: 'LIGHT' },
  SystemBarType: { NavigationBar: 'navigation', StatusBar: 'status' },
}))

import { SystemBarsStyle } from '@capacitor/core'
import {
  setSystemBarHidden,
  systemBarBackground,
  systemBarStyle,
  syncSystemBarsTheme,
} from './systemTheme'

beforeEach(() => {
  vi.clearAllMocks()
  native.getPlatform.mockReturnValue('android')
  native.isNativePlatform.mockReturnValue(true)
})

describe('system bar theme settings', () => {
  it('uses light icons on dark chrome and dark icons on light chrome', () => {
    expect(systemBarStyle('dark', 'app')).toBe(SystemBarsStyle.Dark)
    expect(systemBarStyle('light', 'app')).toBe(SystemBarsStyle.Light)
  })

  it('always keeps light icons over the dark canvas backdrop', () => {
    expect(systemBarStyle('light', 'canvas')).toBe(SystemBarsStyle.Dark)
    expect(systemBarStyle('dark', 'canvas')).toBe(SystemBarsStyle.Dark)
  })

  it('exposes the theme color used by the meta tag', () => {
    expect(systemBarBackground('light')).toBe('#f8f7f3')
    expect(systemBarBackground('dark')).toBe('#262628')
  })

  it('updates icon styles when the theme changes', async () => {
    await syncSystemBarsTheme('dark')

    expect(native.setStyle).toHaveBeenCalledWith({
      style: SystemBarsStyle.Dark,
      bar: 'status',
    })
    expect(native.setStyle).toHaveBeenCalledWith({
      style: SystemBarsStyle.Dark,
      bar: 'navigation',
    })
  })

  it('keeps the navigation bar on the theme style over the canvas', async () => {
    await syncSystemBarsTheme('light', 'canvas')

    expect(native.setStyle).toHaveBeenCalledWith({
      style: SystemBarsStyle.Dark,
      bar: 'status',
    })
    expect(native.setStyle).toHaveBeenCalledWith({
      style: SystemBarsStyle.Light,
      bar: 'navigation',
    })
  })

  it('does not touch system bars on web', async () => {
    native.isNativePlatform.mockReturnValue(false)

    await syncSystemBarsTheme('dark')

    expect(native.setStyle).not.toHaveBeenCalled()
  })

  it('hides and shows the status bar', async () => {
    await setSystemBarHidden(true)
    expect(native.hide).toHaveBeenCalledWith({ bar: 'status' })

    await setSystemBarHidden(false)
    expect(native.show).toHaveBeenCalledWith({ bar: 'status' })
  })

  it('leaves the status bar alone on web', async () => {
    native.isNativePlatform.mockReturnValue(false)

    await setSystemBarHidden(true)

    expect(native.hide).not.toHaveBeenCalled()
  })
})
