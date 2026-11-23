// Long press without a visible menu button: a press that stays put for
// `holdMs` fires the action, and the click that follows the release is
// swallowed so the card does not open as well. Mirrors the WebGL scenes.

export const HOLD_MS = 550
export const HOLD_SLOP = 10

export interface LongPressOptions {
  holdMs?: number
  slop?: number
  enabled?: () => boolean
}

export interface LongPress {
  press: (id: string, ev: PointerEvent) => void
  move: (ev: PointerEvent) => void
  cancel: () => void
  /** True once after a hold fired: the upcoming click must be ignored. */
  consumeClick: () => boolean
}

export function useLongPress(
  onHold: (id: string) => void,
  options: LongPressOptions = {},
): LongPress {
  const holdMs = options.holdMs ?? HOLD_MS
  const slop = options.slop ?? HOLD_SLOP
  let timer: ReturnType<typeof setTimeout> | undefined
  let hold: { id: string; x: number; y: number } | null = null
  let swallowed = false

  function cancel() {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    hold = null
  }

  function press(id: string, ev: PointerEvent) {
    if (options.enabled && !options.enabled()) return
    cancel()
    swallowed = false
    hold = { id, x: ev.clientX, y: ev.clientY }
    timer = setTimeout(() => {
      timer = undefined
      if (!hold) return
      const held = hold.id
      hold = null
      swallowed = true
      onHold(held)
    }, holdMs)
  }

  function move(ev: PointerEvent) {
    if (!hold) return
    if (Math.hypot(ev.clientX - hold.x, ev.clientY - hold.y) > slop) cancel()
  }

  function consumeClick() {
    const wasSwallowed = swallowed
    swallowed = false
    return wasSwallowed
  }

  return { press, move, cancel, consumeClick }
}
