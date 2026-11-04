import { ref } from 'vue'

// User-facing quality settings (settings sheet on the shelf). Kept out of
// the three chunk so the dialog doesn't pull WebGL into the main bundle.
export const QUALITY_LEVELS = ['low', 'medium', 'high', 'ultra'] as const
export type Quality = (typeof QUALITY_LEVELS)[number]

export const GL_QUALITY_KEY = 'vihko:gl-quality'
export const COVER_QUALITY_KEY = 'vihko:cover-quality'

const QUALITY_SET = new Set<string>(QUALITY_LEVELS)

export function readQuality(key: string, fallback: Quality): Quality {
  if (typeof localStorage === 'undefined') return fallback
  const v = localStorage.getItem(key)
  return v && QUALITY_SET.has(v) ? (v as Quality) : fallback
}

// Reactive mirrors of the stored values — views watch these to rebuild
// scenes/textures; localStorage stays the source of truth (and the test
// override point).
export const glQuality = ref<Quality>(readQuality(GL_QUALITY_KEY, 'medium'))
export const coverQuality = ref<Quality>(readQuality(COVER_QUALITY_KEY, 'medium'))

export function setGlQuality(q: Quality) {
  glQuality.value = q
  localStorage.setItem(GL_QUALITY_KEY, q)
}

export function setCoverQuality(q: Quality) {
  coverQuality.value = q
  localStorage.setItem(COVER_QUALITY_KEY, q)
}
