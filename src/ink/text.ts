import type { TextItem } from '../types'
import { resolveFontFamily } from '../fonts'

// Text blocks are laid out in page units: font size, wrap width and line
// height all live in the same space as stroke points, so replay is
// resolution-independent (a layer raster, a 3D thumbnail and the export
// canvas all measure at their own scale without changing the layout).

export const TEXT_LINE_HEIGHT = 1.3

// CSS font-family stack for a built-in key or an imported font id.
export function textFontFamily(font: string | undefined): string {
  return resolveFontFamily(font)
}

// Canvas `font` shorthand for an item. Size is clamped so a malformed save
// can't produce an unparseable font spec.
export function textFontSpec(item: Pick<TextItem, 'size' | 'font' | 'bold' | 'italic'>): string {
  const style = item.italic ? 'italic ' : ''
  const weight = item.bold ? '700' : '400'
  return `${style}${weight} ${Math.max(1, item.size)}px ${textFontFamily(item.font)}`
}

export type Measure = (text: string) => number

export interface TextLayout {
  lines: string[]
  lineHeight: number
  width: number
  height: number
}

// Greedy word wrap honouring explicit newlines; words wider than the box are
// hard-broken by character so they still stay inside it.
export function wrapLines(text: string, maxWidth: number, measure: Measure): string[] {
  const out: string[] = []
  for (const para of text.split(/\r?\n/)) {
    if (!para) {
      out.push('')
      continue
    }
    let line = ''
    for (const word of para.split(' ')) {
      const next = line ? `${line} ${word}` : word
      if (maxWidth <= 0 || measure(next) <= maxWidth) {
        line = next
        continue
      }
      if (line) {
        out.push(line)
        line = ''
      }
      if (measure(word) <= maxWidth) {
        line = word
        continue
      }
      let chunk = ''
      for (const ch of word) {
        if (chunk && measure(chunk + ch) > maxWidth) {
          out.push(chunk)
          chunk = ch
        } else {
          chunk += ch
        }
      }
      line = chunk
    }
    out.push(line)
  }
  return out
}

export function layoutText(item: TextItem, measure: Measure): TextLayout {
  const lines = wrapLines(item.text, item.w, measure)
  const lineHeight = Math.max(1, item.size) * TEXT_LINE_HEIGHT
  let width = 0
  for (const line of lines) width = Math.max(width, measure(line))
  return {
    lines,
    lineHeight,
    width: Math.min(width, item.w > 0 ? item.w : width),
    height: lines.length * lineHeight,
  }
}

// Offscreen measuring context: measureText ignores the canvas transform, so
// the widths it returns are page units for a page-unit font size. Without a
// 2d backend (jsdom, locked-down browsers) fall back to a coarse estimate —
// only the commit-time height and hit-testing use it.
export function measureFor(item: Pick<TextItem, 'size' | 'font' | 'bold' | 'italic'>): Measure {
  try {
    const ctx = document.createElement('canvas').getContext('2d')
    if (ctx && typeof ctx.measureText === 'function') {
      ctx.font = textFontSpec(item as TextItem)
      return (text: string) => ctx.measureText(text).width
    }
  } catch {
    /* no canvas backend */
  }
  const approx = Math.max(1, item.size) * (item.bold ? 0.6 : 0.55)
  return (text: string) => text.length * approx
}
