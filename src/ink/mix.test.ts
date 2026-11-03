import { describe, it, expect } from 'vitest'
import {
  hexToRgb01,
  rgbToHex,
  rgbToRyb,
  rybToRgb,
  mixColors,
  rotateHue,
  hexToHsv,
  hsvToHex,
} from './mix'

describe('hexToRgb01', () => {
  it('parses 6-digit hex with and without #', () => {
    expect(hexToRgb01('#ff0000')).toEqual([1, 0, 0])
    expect(hexToRgb01('00ff00')).toEqual([0, 1, 0])
  })

  it('expands 3-digit shorthand', () => {
    expect(hexToRgb01('#fff')).toEqual([1, 1, 1])
    expect(hexToRgb01('#f00')).toEqual([1, 0, 0])
  })

  it('scales to 0..1', () => {
    const [r, g, b] = hexToRgb01('#808080')
    expect(r).toBeCloseTo(128 / 255)
    expect(g).toBeCloseTo(128 / 255)
    expect(b).toBeCloseTo(128 / 255)
  })
})

describe('rgbToHex', () => {
  it('formats channels', () => {
    expect(rgbToHex([1, 0, 0])).toBe('#ff0000')
    expect(rgbToHex([0, 0, 0])).toBe('#000000')
  })

  it('clamps out-of-range values', () => {
    expect(rgbToHex([1.5, -0.5, 0])).toBe('#ff0000')
  })

  it('rounds to nearest byte', () => {
    expect(rgbToHex([0.5, 0.5, 0.5])).toBe('#808080')
  })
})

describe('rybToRgb', () => {
  it('maps RYB cube corners', () => {
    expect(rybToRgb([0, 0, 0])).toEqual([1, 1, 1]) // white
    expect(rybToRgb([1, 0, 0])).toEqual([1, 0, 0]) // red
    expect(rybToRgb([0, 1, 0])).toEqual([1, 1, 0]) // yellow
    expect(rybToRgb([0, 0, 1])).toEqual([0, 0, 1]) // blue
    expect(rybToRgb([0, 1, 1])).toEqual([0, 1, 0]) // blue+yellow=green
    expect(rybToRgb([1, 1, 0])).toEqual([1, 0.5, 0]) // red+yellow=orange
    expect(rybToRgb([1, 0, 1])).toEqual([0.5, 0, 0.5]) // red+blue=purple
    expect(rybToRgb([1, 1, 1])).toEqual([0, 0, 0]) // black
  })
})

describe('rgbToRyb', () => {
  it('inverts the cube corners', () => {
    expect(rgbToRyb([1, 0, 0])).toEqual([1, 0, 0])
    expect(rgbToRyb([1, 1, 0])).toEqual([0, 1, 0])
    expect(rgbToRyb([0, 0, 1])).toEqual([0, 0, 1])
    expect(rgbToRyb([1, 1, 1])).toEqual([0, 0, 0])
    expect(rgbToRyb([0, 0, 0])).toEqual([1, 1, 1])
  })

  it('round-trips within grid resolution', () => {
    // Nearest-neighbour inversion loses a little precision off-grid.
    for (const ryb of [
      [0.8, 0.2, 0.1],
      [0.1, 0.7, 0.6],
      [0.3, 0.3, 0.9],
    ] as const) {
      const back = rybToRgb(rgbToRyb([...ryb]))
      const orig = rybToRgb([...ryb])
      for (let c = 0; c < 3; c++) expect(back[c]).toBeCloseTo(orig[c], 0)
    }
  })
})

describe('mixColors', () => {
  it('mixing a color with itself is a no-op', () => {
    expect(mixColors('#ff0000', '#ff0000')).toBe('#ff0000')
  })

  it('weight 0 returns the base color', () => {
    expect(mixColors('#ff0000', '#00ff00', 0)).toBe('#ff0000')
  })

  it('red + yellow mixes toward orange (subtractive)', () => {
    // rgbToRyb: red=(1,0,0), yellow=(0,1,0) -> mixed (0.5,0.5,0)
    // -> trilerp = [1, 0.625, 0.25] -> #ff9f40
    expect(mixColors('#ff0000', '#ffff00', 0.5)).toBe('#ff9f40')
  })

  it('blue + yellow gives green, not RGB grey', () => {
    // ryb (0,0.5,0.5) -> trilerp [0.5, 0.75, 0.5] -> #80bf80; a naive RGB
    // average would be #7f7f00 olive.
    const mixed = mixColors('#0000ff', '#ffff00', 0.5)
    expect(mixed).toBe('#80bf80')
    const [r, g, b] = hexToRgb01(mixed)
    expect(g).toBeGreaterThan(r)
    expect(g).toBeGreaterThan(b)
  })
})

describe('rotateHue', () => {
  it('rotates primary colors around the wheel', () => {
    expect(rotateHue('#ff0000', 120)).toBe('#00ff00')
    expect(rotateHue('#ff0000', 240)).toBe('#0000ff')
    expect(rotateHue('#ff0000', -120)).toBe('#0000ff')
  })

  it('360° is an identity', () => {
    expect(rotateHue('#d9a441', 360)).toBe('#d9a441')
    expect(rotateHue('#d9a441', -360)).toBe('#d9a441')
  })

  it('leaves achromatic colors unchanged', () => {
    expect(rotateHue('#808080', 90)).toBe('#808080')
    expect(rotateHue('#ffffff', 45)).toBe('#ffffff')
    expect(rotateHue('#000000', 45)).toBe('#000000')
  })

  it('preserves lightness/saturation on arbitrary hues', () => {
    const once = hexToRgb01(rotateHue('#4a6b8a', 90))
    const orig = hexToRgb01('#4a6b8a')
    const lum = (c: number[]) => (Math.max(...c) + Math.min(...c)) / 2
    const chroma = (c: number[]) => Math.max(...c) - Math.min(...c)
    expect(lum(once)).toBeCloseTo(lum(orig), 2)
    expect(chroma(once)).toBeCloseTo(chroma(orig), 2)
    expect(rotateHue('#4a6b8a', 90)).not.toBe('#4a6b8a')
  })
})

describe('hexToHsv', () => {
  it('converts pure colors', () => {
    expect(hexToHsv('#ff0000')).toEqual([0, 1, 1])
    expect(hexToHsv('#00ff00')).toEqual([120, 1, 1])
    expect(hexToHsv('#0000ff')).toEqual([240, 1, 1])
    expect(hexToHsv('#ffff00')).toEqual([60, 1, 1])
  })

  it('reports zero saturation for achromatic colors', () => {
    expect(hexToHsv('#ffffff')).toEqual([0, 0, 1])
    expect(hexToHsv('#000000')).toEqual([0, 0, 0])
    const [, s, v] = hexToHsv('#808080')
    expect(s).toBe(0)
    expect(v).toBeCloseTo(128 / 255)
  })
})

describe('hsvToHex', () => {
  it('converts pure colors', () => {
    expect(hsvToHex(0, 1, 1)).toBe('#ff0000')
    expect(hsvToHex(120, 1, 1)).toBe('#00ff00')
    expect(hsvToHex(240, 1, 1)).toBe('#0000ff')
    expect(hsvToHex(60, 1, 1)).toBe('#ffff00')
    expect(hsvToHex(0, 0, 0.5)).toBe('#808080')
    expect(hsvToHex(0, 0, 0)).toBe('#000000')
  })

  it('wraps hue and clamps s/v', () => {
    expect(hsvToHex(360, 1, 1)).toBe('#ff0000')
    expect(hsvToHex(-120, 1, 1)).toBe('#0000ff')
    expect(hsvToHex(0, 2, 1)).toBe('#ff0000')
  })

  it('round-trips arbitrary colors within a byte', () => {
    for (const c of ['#d9a441', '#4a6b8a', '#22221f', '#9a7bb8', '#3f8f8a']) {
      const back = hexToRgb01(hsvToHex(...hexToHsv(c)))
      const orig = hexToRgb01(c)
      for (let i = 0; i < 3; i++) expect(back[i]).toBeCloseTo(orig[i], 2)
    }
  })
})
