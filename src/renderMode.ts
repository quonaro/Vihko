import { ref } from 'vue'
import { logger } from './log'

const log = logger('render')

// Graphics mode: '3d' uses the three.js shelf/journal scenes, '2d' renders the
// same views flat with DOM + Canvas2D (no WebGL required). Kept out of the
// three chunk so the settings sheet never pulls WebGL into the main bundle.
export const RENDER_MODES = ['2d', '3d'] as const
export type RenderMode = (typeof RENDER_MODES)[number]

export const RENDER_MODE_KEY = 'vihko:render-mode'

const MODE_SET = new Set<string>(RENDER_MODES)

export function readRenderMode(fallback: RenderMode = '3d'): RenderMode {
  if (typeof localStorage === 'undefined') return fallback
  const v = localStorage.getItem(RENDER_MODE_KEY)
  return v && MODE_SET.has(v) ? (v as RenderMode) : fallback
}

// Reactive mirror of the stored value — views watch it to swap renderers.
// localStorage stays the source of truth (and the test override point).
export const renderMode = ref<RenderMode>(readRenderMode())

export function setRenderMode(mode: RenderMode) {
  log.debug('render mode set', mode)
  renderMode.value = mode
  localStorage.setItem(RENDER_MODE_KEY, mode)
}
