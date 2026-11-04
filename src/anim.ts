// Lightweight shared-element morph: clones the source element's look into a
// fixed-position overlay, animates it to `target`, then removes itself.
// Call the real view switch ~100-150ms in so the morph overlaps the incoming view.

export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

export function morphTo(
  target: Rect,
  source: HTMLElement,
  opts: {
    fade?: boolean
    extraTransform?: string
    // ms to hold the clone at its start state before it moves/fades —
    // lets a fullscreen hand-off cover the incoming view a bit longer.
    delay?: number
  } = {},
) {
  const r = source.getBoundingClientRect()
  const cs = getComputedStyle(source)

  const clone = document.createElement('div')
  clone.className = 'morph'
  Object.assign(clone.style, {
    left: `${r.left}px`,
    top: `${r.top}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
    background: cs.background,
    borderRadius: cs.borderRadius,
    boxShadow: '0 24px 70px rgba(0,0,0,0.5)',
  })
  document.body.appendChild(clone)

  // FLIP: the clone keeps the source geometry and is moved purely by
  // transform (compositor-only). Animating left/top/width/height would
  // force layout + repaint of the shadow every frame — jank on mobile.
  const dx = target.left - r.left
  const dy = target.top - r.top
  const sx = r.width > 0 ? target.width / r.width : 1
  const sy = r.height > 0 ? target.height / r.height : 1

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      Object.assign(clone.style, {
        transform:
          `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` +
          (opts.extraTransform ? ` ${opts.extraTransform}` : ''),
        borderRadius: '4px',
        opacity: opts.fade === false ? '1' : '0',
        transitionDelay: opts.delay ? `${opts.delay}ms` : '',
      })
    })
  })

  setTimeout(() => clone.remove(), 400 + (opts.delay ?? 0))
}

export function centeredRect(scale = 0.86): Rect {
  const w = Math.min(window.innerWidth * scale, 900)
  const h = Math.min(window.innerHeight * scale, 700)
  return {
    left: (window.innerWidth - w) / 2,
    top: (window.innerHeight - h) / 2,
    width: w,
    height: h,
  }
}

export function fullRect(): Rect {
  return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
}
