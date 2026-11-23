import { afterEach, describe, expect, it } from 'vitest'
import { RENDER_MODE_KEY, readRenderMode, renderMode, setRenderMode } from './renderMode'

describe('render mode setting', () => {
  afterEach(() => {
    localStorage.removeItem(RENDER_MODE_KEY)
    setRenderMode('3d')
  })

  it('defaults to 3d and ignores garbage', () => {
    expect(readRenderMode()).toBe('3d')
    localStorage.setItem(RENDER_MODE_KEY, '2d')
    expect(readRenderMode()).toBe('2d')
    localStorage.setItem(RENDER_MODE_KEY, 'flat')
    expect(readRenderMode()).toBe('3d')
    expect(readRenderMode('2d')).toBe('2d')
  })

  it('persists the mode and updates the ref', () => {
    setRenderMode('2d')
    expect(renderMode.value).toBe('2d')
    expect(localStorage.getItem(RENDER_MODE_KEY)).toBe('2d')
    setRenderMode('3d')
    expect(renderMode.value).toBe('3d')
    expect(localStorage.getItem(RENDER_MODE_KEY)).toBe('3d')
  })
})
