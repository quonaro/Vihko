import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  getPlatform: vi.fn(() => 'android'),
  isNativePlatform: vi.fn(() => true),
  setBackgroundColor: vi.fn(async () => {}),
  setStyle: vi.fn(async () => {}),
}))

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: native.getPlatform,
    isNativePlatform: native.isNativePlatform,
  },
  registerPlugin: () => ({ setBackgroundColor: native.setBackgroundColor }),
  SystemBars: { setStyle: native.setStyle },
  SystemBarsStyle: { Dark: 'DARK', Light: 'LIGHT' },
  SystemBarType: { StatusBar: 'status' },
}))

import { SystemBarsStyle } from '@capacitor/core'
import { getSystemBarSettings, syncSystemBarsTheme } from './systemTheme'

beforeEach(() => {
  vi.clearAllMocks()
  native.getPlatform.mockReturnValue('android')
  native.isNativePlatform.mockReturnValue(true)
})

describe('system bar theme settings', () => {
  it('uses light icons and a dark background in dark theme', () => {
    expect(getSystemBarSettings('dark')).toEqual({
      style: SystemBarsStyle.Dark,
      backgroundColor: '#262628',
    })
  })

  it('uses dark icons and a light background in light theme', () => {
    expect(getSystemBarSettings('light')).toEqual({
      style: SystemBarsStyle.Light,
      backgroundColor: '#f8f7f3',
    })
  })

  it('updates Android icon style and background when the theme changes', async () => {
    await syncSystemBarsTheme('dark')

    expect(native.setStyle).toHaveBeenCalledWith({
      style: SystemBarsStyle.Dark,
      bar: 'status',
    })
    expect(native.setBackgroundColor).toHaveBeenCalledWith({ color: '#262628' })
  })

  it('updates icons without calling the Android background bridge on iOS', async () => {
    native.getPlatform.mockReturnValue('ios')

    await syncSystemBarsTheme('light')

    expect(native.setStyle).toHaveBeenCalledWith({
      style: SystemBarsStyle.Light,
      bar: 'status',
    })
    expect(native.setBackgroundColor).not.toHaveBeenCalled()
  })

  it('does not touch system bars on web', async () => {
    native.isNativePlatform.mockReturnValue(false)

    await syncSystemBarsTheme('dark')

    expect(native.setStyle).not.toHaveBeenCalled()
    expect(native.setBackgroundColor).not.toHaveBeenCalled()
  })
})
