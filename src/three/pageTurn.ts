import { logger } from '../log'

const log = logger('turn')

// Page-turn transition state machine for the journal spread — pure math with
// no three.js/DOM imports, so it unit-tests like layout.ts/gesture.ts.
//
// One leaf is live at a time and ONE rendered progress value drives every
// phase: `drag` writes it directly while the finger is down, and a release
// starts a settle segment from that exact value toward 0 (cancel) or 1
// (commit). Easing shapes only the elapsed-time fraction inside the segment
// — never the rendered progress itself. (The old scene kept a raw flipT for
// the finger but re-ran easeInOut over it once the finger lifted, so the leaf
// visibly jumped at the release frame.)
//
// `srcIndex` is the front sheet when the turn began; `dstIndex` is where the
// front lands on commit. The turning leaf belongs to min(src, dst) and
// reveals max(src, dst) beneath it — the scene's hide/reveal pair.

export type TurnDir = 1 | -1
export type TurnPhase = 'idle' | 'dragging' | 'settling'

// release() with no argument commits at or past this rendered progress;
// below it the leaf settles back. Flicks can commit earlier — the caller
// folds velocity into an explicit release(commit) decision.
export const COMMIT_AT = 0.45

// Seconds for a full 0→1 settle. Segments scale by their distance so the
// leaf's speed doesn't depend on where the finger lifted. Cancels run
// faster — a rejected turn should snap back, not float.
export const SETTLE_TIME = 0.62
export const CANCEL_TIME = SETTLE_TIME * 0.65

// Ease applied to a settle segment's elapsed-time fraction ONLY.
export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)

export type CanTurn = (dir: TurnDir, cur: number, total: number) => boolean

export interface TurnResult {
  type: 'commit' | 'cancel'
  dir: TurnDir
  srcIndex: number
  dstIndex: number
  // Front index the journal should show afterwards: dstIndex on commit,
  // srcIndex (unchanged) on cancel.
  index: number
}

export interface PageTurnOptions {
  settleTime?: number // full-span commit duration, s (default SETTLE_TIME)
  cancelTime?: number // full-span cancel duration, s (default CANCEL_TIME)
  // Ease for the settle segment's time fraction (default easeInOut).
  ease?: (u: number) => number
  // Bounds predicate; defaults to the stack rule inlined below. The
  // integrator can pass layout.ts's canTurnStack here.
  canTurn?: CanTurn
  // Default release() commit threshold (default COMMIT_AT).
  commitAt?: number
  onResult?: (r: TurnResult) => void
}

export interface PageTurn {
  readonly phase: TurnPhase
  readonly dir: TurnDir
  readonly srcIndex: number
  readonly dstIndex: number
  // Rendered 0..1 — the single value every phase reads and writes.
  readonly progress: number
  readonly busy: boolean
  // Sheet indices while busy, null when idle: the leaf being turned and the
  // sheet it reveals beneath — the scene's hideIdx/revealIdx pair.
  readonly leafIndex: number | null
  readonly revealIndex: number | null
  // Where the live settle is heading (null when not settling).
  readonly settleTarget: 0 | 1 | null

  // Start a finger-driven turn at progress 0. Returns false when a
  // transition is already live (secondary pointers / new requests can't
  // steal the leaf) or when the stack can't turn that way.
  begin(dir: TurnDir, cur: number, total: number): boolean
  // Programmatic turn (button/wheel): begin + immediate settle to 1.
  flip(dir: TurnDir, cur: number, total: number): boolean
  // Write rendered progress directly. `s` is the finger's SIGNED turn
  // amount: positive pulls forward, negative pulls back, |s| is stored
  // clamped to 0..1. Reversal under the finger is just s crossing 0 — the
  // machine swaps the live leaf to the other pile when a sheet exists
  // there. Callers holding an unsigned per-direction value pass t * dir.
  drag(s: number): void
  // Finger up: settle from the current rendered progress to 1 (commit) or
  // 0 (cancel). No-op unless dragging — a live settle can't be retargeted.
  release(commit?: boolean): void
  // Pointer cancelled (or an abort): settle back to 0 from wherever the
  // leaf is rendered now — including mid-settle redirects.
  cancel(): void
  // Hard stop to idle with no result — for mode switches / setPages.
  reset(): void
  // Advance a live settle by dt seconds; returns the rendered progress.
  tick(dt: number): number
  // Poll the one-shot completion event (commit lands dstIndex, cancel
  // keeps srcIndex). Drains the slot — a second call returns null.
  takeResult(): TurnResult | null
}

// NOTE for the integrator: matches canTurnStack() in layout.ts — inlined to
// keep this module dependency-free while layout.ts is rewritten in parallel;
// pass the real one via PageTurnOptions.canTurn once wired up.
const defaultCanTurn: CanTurn = (dir, cur, total) =>
  total > 0 && cur >= 0 && cur < total && (dir > 0 ? cur < total - 1 : cur > 0)

export function createPageTurn(opts: PageTurnOptions = {}): PageTurn {
  const settleTime = opts.settleTime ?? SETTLE_TIME
  const cancelTime = opts.cancelTime ?? CANCEL_TIME
  const ease = opts.ease ?? easeInOut
  const canTurn = opts.canTurn ?? defaultCanTurn
  const commitAt = opts.commitAt ?? COMMIT_AT
  const onResult = opts.onResult

  let phase: TurnPhase = 'idle'
  let dir: TurnDir = 1
  let srcIndex = 0
  let dstIndex = 0
  let total = 0
  let progress = 0
  // Settle segment: rendered progress lerps from → to across `segDur`
  // seconds, with `ease` shaping only the elapsed-time fraction.
  let segFrom = 0
  let segTo: 0 | 1 = 0
  let segDur = 0
  let segElapsed = 0
  let pending: TurnResult | null = null

  function startSettle(to: 0 | 1) {
    if (phase === 'settling' && segTo === to) return
    // The segment starts at the exact rendered progress — the release frame
    // shows what the finger left behind, not an eased copy of it.
    segFrom = progress
    segTo = to
    segElapsed = 0
    segDur = (to === 1 ? settleTime : cancelTime) * Math.abs(to - segFrom)
    phase = 'settling'
  }

  function emit(type: 'commit' | 'cancel') {
    log.debug('turn settled', { type, dir, srcIndex, dstIndex })
    const r: TurnResult = {
      type,
      dir,
      srcIndex,
      dstIndex,
      index: type === 'commit' ? dstIndex : srcIndex,
    }
    pending = r
    onResult?.(r)
  }

  function begin(d: TurnDir, cur: number, t: number): boolean {
    if (phase !== 'idle') return false
    if (!canTurn(d, cur, t)) {
      log.debug('turn begin rejected at the stack edge', { d, cur, t })
      return false
    }
    log.debug('turn begin', { d, cur })
    phase = 'dragging'
    dir = d
    srcIndex = cur
    dstIndex = cur + d
    total = t
    progress = 0
    pending = null
    return true
  }

  function flip(d: TurnDir, cur: number, t: number): boolean {
    if (!begin(d, cur, t)) return false
    release(true)
    return true
  }

  function drag(s: number) {
    if (phase !== 'dragging') return
    const want: TurnDir = s > 0 ? 1 : s < 0 ? -1 : dir
    if (want !== dir) {
      // Reversal under the finger: only swap the leaf if the other pile has
      // a sheet to give — otherwise the turn rests flat at the spine.
      if (!canTurn(want, srcIndex, total)) {
        progress = 0
        return
      }
      dir = want
      dstIndex = srcIndex + want
    }
    progress = Math.min(1, Math.abs(s))
  }

  function release(commit = progress >= commitAt) {
    if (phase !== 'dragging') return
    log.debug('turn released', { commit, progress })
    startSettle(commit ? 1 : 0)
  }

  function cancel() {
    if (phase === 'idle') return
    startSettle(0)
  }

  function reset() {
    phase = 'idle'
    progress = 0
    pending = null
  }

  function tick(dt: number): number {
    if (phase !== 'settling') return progress
    segElapsed += Math.max(0, dt)
    const u = segDur <= 0 ? 1 : Math.min(1, segElapsed / segDur)
    progress = segFrom + (segTo - segFrom) * ease(u)
    if (u >= 1) {
      // Land exactly — no float residue past the ease — and report once.
      progress = segTo
      phase = 'idle'
      emit(segTo === 1 ? 'commit' : 'cancel')
    }
    return progress
  }

  function takeResult(): TurnResult | null {
    const r = pending
    pending = null
    return r
  }

  return {
    get phase() {
      return phase
    },
    get dir() {
      return dir
    },
    get srcIndex() {
      return srcIndex
    },
    get dstIndex() {
      return dstIndex
    },
    get progress() {
      return progress
    },
    get busy() {
      return phase !== 'idle'
    },
    get leafIndex() {
      return phase === 'idle' ? null : Math.min(srcIndex, dstIndex)
    },
    get revealIndex() {
      return phase === 'idle' ? null : Math.max(srcIndex, dstIndex)
    },
    get settleTarget() {
      return phase === 'settling' ? segTo : null
    },
    begin,
    flip,
    drag,
    release,
    cancel,
    reset,
    tick,
    takeResult,
  }
}
