import { vi } from 'vitest'

// Deterministic rAF for animation code (jsdom may lack it; tests also run
// under fake timers where a real rAF would never fire).
vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
  setTimeout(() => cb(performance.now()), 0)
  return 1
})
vi.stubGlobal('cancelAnimationFrame', () => {})

// Pointer capture isn't implemented in jsdom.
const el = Element.prototype as Element & {
  setPointerCapture?: (id: number) => void
  releasePointerCapture?: (id: number) => void
  hasPointerCapture?: (id: number) => boolean
}
el.setPointerCapture ??= () => {}
el.releasePointerCapture ??= () => {}
el.hasPointerCapture ??= () => false

// jsdom has no canvas backend; return a quiet null instead of logging
// "Not implemented" errors from getContext('2d').
HTMLCanvasElement.prototype.getContext = (() =>
  null) as unknown as typeof HTMLCanvasElement.prototype.getContext

// No layout in jsdom: elementFromPoint doesn't exist.
Object.defineProperty(document, 'elementFromPoint', {
  value: () => null,
  writable: true,
  configurable: true,
})

// jsdom lacks matchMedia (MobileSlider's mobile breakpoint).
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  configurable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }),
})
