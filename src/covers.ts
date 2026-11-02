// Preset cover art for the cover picker — small generative designs baked
// to dataURLs once at startup (no external assets).

const W = 340
const H = 480
const FALLBACK_COVER = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='

function bake(draw: (c: CanvasRenderingContext2D) => void): string {
  const el = document.createElement('canvas')
  el.width = W
  el.height = H
  const ctx = el.getContext('2d')
  if (!ctx) return FALLBACK_COVER // no canvas backend (e.g. jsdom tests)
  draw(ctx)
  return el.toDataURL('image/jpeg', 0.85)
}

const mulberry32 = (seed: number) => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

export const presetCovers: { id: string; src: string }[] = [
  {
    id: 'sunset',
    src: bake((c) => {
      const g = c.createLinearGradient(0, 0, 0, H)
      g.addColorStop(0, '#e2601e')
      g.addColorStop(0.55, '#f2c43d')
      g.addColorStop(1, '#7a3a52')
      c.fillStyle = g
      c.fillRect(0, 0, W, H)
      c.fillStyle = 'rgba(255,244,214,0.9)'
      c.beginPath()
      c.arc(W * 0.5, H * 0.42, 58, 0, Math.PI * 2)
      c.fill()
      c.fillStyle = 'rgba(60,40,60,0.55)'
      for (let i = 0; i < 4; i++) c.fillRect(0, H * 0.62 + i * 26, W, 10 - i * 2)
    }),
  },
  {
    id: 'waves',
    src: bake((c) => {
      c.fillStyle = '#2f4a5a'
      c.fillRect(0, 0, W, H)
      for (let i = 0; i < 9; i++) {
        c.fillStyle = `rgba(122,158,126,${0.08 + i * 0.05})`
        c.beginPath()
        const y0 = H * 0.3 + i * 34
        c.moveTo(0, y0)
        for (let x = 0; x <= W; x += 8) {
          c.lineTo(x, y0 + Math.sin(x / 46 + i * 0.9) * 16)
        }
        c.lineTo(W, H); c.lineTo(0, H)
        c.closePath()
        c.fill()
      }
    }),
  },
  {
    id: 'dots',
    src: bake((c) => {
      c.fillStyle = '#3a3f4a'
      c.fillRect(0, 0, W, H)
      const cols = ['#d9a441', '#e2601e', '#7a9e7e', '#9a7bb8', '#f6f1e6']
      const rand = mulberry32(7)
      for (let y = 30; y < H; y += 44) {
        for (let x = 30; x < W; x += 44) {
          c.fillStyle = cols[Math.floor(rand() * cols.length)]
          c.globalAlpha = 0.55 + rand() * 0.4
          c.beginPath()
          c.arc(x, y, 3 + rand() * 7, 0, Math.PI * 2)
          c.fill()
        }
      }
      c.globalAlpha = 1
    }),
  },
  {
    id: 'grid',
    src: bake((c) => {
      c.fillStyle = '#f6f1e6'
      c.fillRect(0, 0, W, H)
      c.strokeStyle = 'rgba(74,107,138,0.55)'
      c.lineWidth = 1
      for (let x = 0; x <= W; x += 24) {
        c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke()
      }
      for (let y = 0; y <= H; y += 24) {
        c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke()
      }
      c.strokeStyle = '#e2601e'
      c.lineWidth = 3
      c.beginPath()
      c.moveTo(W * 0.2, H * 0.72)
      c.bezierCurveTo(W * 0.4, H * 0.4, W * 0.6, H * 0.5, W * 0.8, H * 0.25)
      c.stroke()
    }),
  },
  {
    id: 'terrain',
    src: bake((c) => {
      const g = c.createLinearGradient(0, 0, W, H)
      g.addColorStop(0, '#3f5a4c')
      g.addColorStop(1, '#1f2f28')
      c.fillStyle = g
      c.fillRect(0, 0, W, H)
      const rand = mulberry32(21)
      c.strokeStyle = 'rgba(217,164,65,0.5)'
      for (let ring = 0; ring < 6; ring++) {
        const cx = W * (0.25 + rand() * 0.5)
        const cy = H * (0.25 + rand() * 0.5)
        c.lineWidth = 1 + rand()
        for (let r = 20; r < 130; r += 18) {
          c.beginPath()
          c.arc(cx, cy, r + rand() * 8, rand() * 3, rand() * 2 + 3.2)
          c.stroke()
        }
      }
    }),
  },
  {
    id: 'mono',
    src: bake((c) => {
      c.fillStyle = '#22221f'
      c.fillRect(0, 0, W, H)
      const rand = mulberry32(99)
      c.strokeStyle = 'rgba(246,241,230,0.75)'
      for (let i = 0; i < 26; i++) {
        c.lineWidth = 0.6 + rand() * 2.4
        c.beginPath()
        const x = rand() * W
        c.moveTo(x, rand() * H * 0.4)
        c.lineTo(x + (rand() - 0.5) * 120, H * (0.5 + rand() * 0.5))
        c.stroke()
      }
      c.fillStyle = '#d9a441'
      c.fillRect(W * 0.42, H * 0.46, W * 0.16, H * 0.09)
    }),
  },
]
