import { afterEach, describe, expect, it } from 'vitest'
import {
  COVER_QUALITY_KEY,
  GL_QUALITY_KEY,
  coverQuality,
  glQuality,
  readQuality,
  setCoverQuality,
  setGlQuality,
} from './quality'

describe('quality settings', () => {
  afterEach(() => {
    localStorage.removeItem(GL_QUALITY_KEY)
    localStorage.removeItem(COVER_QUALITY_KEY)
    setGlQuality('medium')
    setCoverQuality('medium')
  })

  it('parses stored values and falls back on garbage', () => {
    expect(readQuality(GL_QUALITY_KEY, 'medium')).toBe('medium')
    localStorage.setItem(GL_QUALITY_KEY, 'ultra')
    expect(readQuality(GL_QUALITY_KEY, 'low')).toBe('ultra')
    localStorage.setItem(GL_QUALITY_KEY, 'potato')
    expect(readQuality(GL_QUALITY_KEY, 'low')).toBe('low')
    expect(readQuality(GL_QUALITY_KEY, 'high')).toBe('high')
  })

  it('persists the render quality and updates the ref', () => {
    setGlQuality('ultra')
    expect(glQuality.value).toBe('ultra')
    expect(localStorage.getItem(GL_QUALITY_KEY)).toBe('ultra')
  })

  it('persists the cover quality and updates the ref', () => {
    setCoverQuality('low')
    expect(coverQuality.value).toBe('low')
    expect(localStorage.getItem(COVER_QUALITY_KEY)).toBe('low')
  })
})
