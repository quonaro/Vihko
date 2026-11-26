import { describe, it, expect } from 'vitest'
import { layoutText, textFontFamily, textFontSpec, wrapLines } from './text'
import type { TextItem } from '../types'

// Fixed-width measurer: every character is 10 page units wide, so wrapping is
// predictable without a canvas backend.
const measure = (text: string) => text.length * 10

const item = (patch: Partial<TextItem> = {}): TextItem => ({
  text: 'hello world',
  x: 0,
  y: 0,
  w: 60, // 'hello' fits, 'hello world' (110) does not
  h: 0,
  size: 20,
  color: '#22221f',
  font: 'sans',
  align: 'left',
  ...patch,
})

describe('text layout', () => {
  it('wraps greedily at word boundaries', () => {
    expect(wrapLines('hello world', 60, measure)).toEqual(['hello', 'world'])
    expect(wrapLines('one two three', 80, measure)).toEqual(['one two', 'three'])
  })

  it('honours explicit newlines and preserves blank lines', () => {
    expect(wrapLines('a\n\nb', 100, measure)).toEqual(['a', '', 'b'])
  })

  it('hard-breaks words that are wider than the box', () => {
    expect(wrapLines('abcdef', 40, measure)).toEqual(['abcd', 'ef'])
  })

  it('never wraps when the width is non-positive', () => {
    expect(wrapLines('hello world', 0, measure)).toEqual(['hello world'])
  })

  it('reports the line height, laid-out width and total height', () => {
    const l = layoutText(item({ size: 20 }), measure)
    expect(l.lines).toEqual(['hello', 'world'])
    expect(l.lineHeight).toBeCloseTo(26, 5)
    expect(l.height).toBeCloseTo(52, 5)
    expect(l.width).toBe(50)
  })

  it('clamps the reported width to the wrap box', () => {
    // A single word wider than the box is broken, so width stays inside it.
    const l = layoutText(item({ text: 'abcdef', w: 40 }), measure)
    expect(l.width).toBeLessThanOrEqual(40)
  })
})

describe('text fonts', () => {
  it('maps font keys to concrete stacks', () => {
    expect(textFontFamily('serif')).toContain('Georgia')
    expect(textFontFamily('mono')).toContain('monospace')
    expect(textFontFamily(undefined)).toBe(textFontFamily('sans'))
  })

  it('builds the canvas font shorthand with size, weight and style', () => {
    expect(textFontSpec(item({ size: 48 }))).toBe(`400 48px ${textFontFamily('sans')}`)
    expect(textFontSpec(item({ size: 48, bold: true, italic: true, font: 'serif' }))).toBe(
      `italic 700 48px ${textFontFamily('serif')}`,
    )
  })
})
