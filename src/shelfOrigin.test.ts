import { describe, expect, it } from 'vitest'
import { rememberShelfOrigin, takeShelfOrigin } from './shelfOrigin'

describe('shelf origin hint', () => {
  it('is empty until a journal leaves the screen', () => {
    expect(takeShelfOrigin()).toBeNull()
  })

  it('hands the last journal id to the shelf exactly once', () => {
    rememberShelfOrigin('j2')
    expect(takeShelfOrigin()).toBe('j2')
    expect(takeShelfOrigin()).toBeNull()
  })

  it('forgets the hint when the next leave has no journal', () => {
    rememberShelfOrigin('j1')
    rememberShelfOrigin(null)
    expect(takeShelfOrigin()).toBeNull()
  })
})
