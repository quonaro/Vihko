// Compact RYB (artists' subtractive) color mixing, approximated by trilinear
// interpolation over the RYB cube — blue+yellow->green, red+blue->purple.

type RGB = [number, number, number]

// Standard RGB<->RYB corner mapping (used in the well-known paper js
// implementations): RYB(r,y,b) -> RGB via trilinear interp over this cube:
const CUBE: RGB[] = [
  [1, 1, 1], // r=0,y=0,b=0 : white
  [0, 0, 1], // r=0,y=0,b=1 : blue
  [1, 1, 0], // r=0,y=1,b=0 : yellow
  [0, 1, 0], // r=0,y=1,b=1 : green
  [1, 0, 0], // r=1,y=0,b=0 : red
  [0.5, 0, 0.5], // r=1,y=0,b=1 : purple
  [1, 0.5, 0], // r=1,y=1,b=0 : orange
  [0, 0, 0], // r=1,y=1,b=1 : black
]

function trilerp(cube: RGB[], r: number, y: number, b: number): RGB {
  // cube index: bit0 = b, bit1 = y, bit2 = r
  const pick = (ri: number, yi: number, bi: number) => cube[ri * 4 + yi * 2 + bi]
  const out: RGB = [0, 0, 0]
  for (let c = 0; c < 3; c++) {
    const c00 = pick(0, 0, 0)[c] * (1 - b) + pick(0, 0, 1)[c] * b
    const c01 = pick(0, 1, 0)[c] * (1 - b) + pick(0, 1, 1)[c] * b
    const c10 = pick(1, 0, 0)[c] * (1 - b) + pick(1, 0, 1)[c] * b
    const c11 = pick(1, 1, 0)[c] * (1 - b) + pick(1, 1, 1)[c] * b
    const c0 = c00 * (1 - y) + c01 * y
    const c1 = c10 * (1 - y) + c11 * y
    out[c] = c0 * (1 - r) + c1 * r
  }
  return out
}

// Invert: RGB -> RYB is underdetermined; approximate via nearest-neighbour
// sampling of the forward map (coarse grid).
let rybGrid: { rgb: RGB; ryb: RGB }[] | null = null
function buildGrid() {
  rybGrid = []
  const N = 9
  for (let r = 0; r <= N; r++)
    for (let y = 0; y <= N; y++)
      for (let b = 0; b <= N; b++) {
        const ryb: RGB = [r / N, y / N, b / N]
        rybGrid.push({ rgb: trilerp(CUBE, ...ryb), ryb })
      }
}

export function rgbToRyb(rgb: RGB): RGB {
  if (!rybGrid) buildGrid()
  let best: RGB = [0, 0, 0]
  let bestD = Infinity
  for (const g of rybGrid!) {
    const d = (g.rgb[0] - rgb[0]) ** 2 + (g.rgb[1] - rgb[1]) ** 2 + (g.rgb[2] - rgb[2]) ** 2
    if (d < bestD) {
      bestD = d
      best = g.ryb
    }
  }
  return best
}

export function rybToRgb(ryb: RGB): RGB {
  return trilerp(CUBE, ...ryb)
}

export function hexToRgb01(hex: string): RGB {
  const h = hex.replace('#', '')
  const v =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h
  return [
    parseInt(v.slice(0, 2), 16) / 255,
    parseInt(v.slice(2, 4), 16) / 255,
    parseInt(v.slice(4, 6), 16) / 255,
  ]
}

export function rgbToHex([r, g, b]: RGB): string {
  const c = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

// Mix `into` with `ingredient`; weight = fraction of ingredient (0..1).
export function mixColors(into: string, ingredient: string, weight = 0.35): string {
  const a = rgbToRyb(hexToRgb01(into))
  const b = rgbToRyb(hexToRgb01(ingredient))
  const mixed: RGB = [
    a[0] * (1 - weight) + b[0] * weight,
    a[1] * (1 - weight) + b[1] * weight,
    a[2] * (1 - weight) + b[2] * weight,
  ]
  return rgbToHex(rybToRgb(mixed))
}

// Hex <-> HSV (h: 0..360, s/v: 0..1) for the color picker modal.
export function hexToHsv(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb01(hex)
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d > 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6)
    else if (max === g) h = 60 * ((b - r) / d + 2)
    else h = 60 * ((r - g) / d + 4)
  }
  if (h < 0) h += 360
  return [h, max === 0 ? 0 : d / max, max]
}

export function hsvToHex(h: number, s: number, v: number): string {
  h = ((h % 360) + 360) % 360
  s = Math.min(1, Math.max(0, s))
  v = Math.min(1, Math.max(0, v))
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  let rgb: RGB
  if (h < 60) rgb = [c, x, 0]
  else if (h < 120) rgb = [x, c, 0]
  else if (h < 180) rgb = [0, c, x]
  else if (h < 240) rgb = [0, x, c]
  else if (h < 300) rgb = [x, 0, c]
  else rgb = [c, 0, x]
  return rgbToHex([rgb[0] + m, rgb[1] + m, rgb[2] + m])
}

// Rotate hue of a hex color by degrees.
export function rotateHue(hex: string, deg: number): string {
  const [r, g, b] = hexToRgb01(hex)
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  let h = 0
  let s = 0
  if (d > 0) {
    s = d / (1 - Math.abs(2 * l - 1))
    if (max === r) h = 60 * (((g - b) / d) % 6)
    else if (max === g) h = 60 * ((b - r) / d + 2)
    else h = 60 * ((r - g) / d + 4)
  }
  h = (h + deg + 360) % 360
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let rgb: RGB = [0, 0, 0]
  if (h < 60) rgb = [c, x, 0]
  else if (h < 120) rgb = [x, c, 0]
  else if (h < 180) rgb = [0, c, x]
  else if (h < 240) rgb = [0, x, c]
  else if (h < 300) rgb = [x, 0, c]
  else rgb = [c, 0, x]
  return rgbToHex([rgb[0] + m, rgb[1] + m, rgb[2] + m])
}
