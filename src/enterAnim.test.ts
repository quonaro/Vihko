import { afterEach, describe, expect, it, vi } from 'vitest'
import { ENTER_ANIMS, ENTER_ANIM_KEY, enterAnim, setEnterAnim } from './enterAnim'

describe('enterAnim setting', () => {
  afterEach(() => {
    localStorage.removeItem(ENTER_ANIM_KEY)
    setEnterAnim('dive')
  })

  it('offers dive, open and morph', () => {
    expect(ENTER_ANIMS).toEqual(['dive', 'open', 'morph'])
  })

  it('persists the choice and updates the ref', () => {
    setEnterAnim('open')
    expect(enterAnim.value).toBe('open')
    expect(localStorage.getItem(ENTER_ANIM_KEY)).toBe('open')
    setEnterAnim('morph')
    expect(enterAnim.value).toBe('morph')
    expect(localStorage.getItem(ENTER_ANIM_KEY)).toBe('morph')
  })

  it('restores a stored value on a fresh module load', async () => {
    localStorage.setItem(ENTER_ANIM_KEY, 'open')
    vi.resetModules()
    const { enterAnim: fresh } = await import('./enterAnim')
    expect(fresh.value).toBe('open')
  })
})
