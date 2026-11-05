import { ref } from 'vue'
import { logger } from './log'

const log = logger('anim')

// Journal-open transition picked in the settings sheet. 'dive' flies the
// shelf camera into the tapped cover, 'open' lifts the book and hinges its
// front board open; 'morph' is the flat DOM shared-element morph (and the
// fallback when the scene can't run the 3D move).
export const ENTER_ANIMS = ['dive', 'open', 'morph'] as const
export type EnterAnim = (typeof ENTER_ANIMS)[number]

export const ENTER_ANIM_KEY = 'vihko:enter-anim'

const SET = new Set<string>(ENTER_ANIMS)

function readEnterAnim(): EnterAnim {
  if (typeof localStorage === 'undefined') return 'dive'
  const v = localStorage.getItem(ENTER_ANIM_KEY)
  return v && SET.has(v) ? (v as EnterAnim) : 'dive'
}

export const enterAnim = ref<EnterAnim>(readEnterAnim())

export function setEnterAnim(v: EnterAnim) {
  log.debug('enter anim set', v)
  enterAnim.value = v
  localStorage.setItem(ENTER_ANIM_KEY, v)
}
