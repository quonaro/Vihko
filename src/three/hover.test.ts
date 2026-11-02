import { describe, expect, it } from 'vitest'
import { shouldClearHoverOnCanvasLeave } from './hover'

describe('shouldClearHoverOnCanvasLeave', () => {
  it('keeps the page hovered while the pointer moves onto an overlay in the stage', () => {
    const stage = document.createElement('div')
    const button = document.createElement('button')
    stage.append(button)

    expect(shouldClearHoverOnCanvasLeave(button, stage)).toBe(false)
  })

  it('clears the page hover when the pointer leaves the stage', () => {
    const stage = document.createElement('div')
    const outside = document.createElement('button')

    expect(shouldClearHoverOnCanvasLeave(outside, stage)).toBe(true)
    expect(shouldClearHoverOnCanvasLeave(null, stage)).toBe(true)
  })
})
