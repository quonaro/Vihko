import { describe, it, expect, vi } from 'vitest'
import { createPageTurn, SETTLE_TIME, type PageTurn } from './pageTurn'

// Run the settle out in slices past its full duration; the loop is
// over-budgeted so the final segment lands exactly on the target.
function settleOut(t: PageTurn, steps = 80, dt = 0.03): number {
  let p = t.progress
  for (let i = 0; i < steps && t.phase === 'settling'; i++) p = t.tick(dt)
  return p
}

describe('begin', () => {
  it('enters dragging at progress 0 with src/dst in the drag direction', () => {
    const t = createPageTurn()
    expect(t.begin(1, 2, 5)).toBe(true)
    expect(t.phase).toBe('dragging')
    expect(t.busy).toBe(true)
    expect(t.dir).toBe(1)
    expect(t.srcIndex).toBe(2)
    expect(t.dstIndex).toBe(3)
    expect(t.progress).toBe(0)
    expect(t.leafIndex).toBe(2)
    expect(t.revealIndex).toBe(3)
  })

  it('points src/dst the other way for a backward turn', () => {
    const t = createPageTurn()
    expect(t.begin(-1, 2, 5)).toBe(true)
    expect(t.dir).toBe(-1)
    expect(t.srcIndex).toBe(2)
    expect(t.dstIndex).toBe(1)
    expect(t.leafIndex).toBe(1) // the turned leaf comes off the left pile
    expect(t.revealIndex).toBe(2)
  })

  it('refuses to turn past the last sheet', () => {
    const t = createPageTurn()
    expect(t.begin(1, 4, 5)).toBe(false)
    expect(t.phase).toBe('idle')
  })

  it('refuses to turn back before the first sheet', () => {
    const t = createPageTurn()
    expect(t.begin(-1, 0, 5)).toBe(false)
    expect(t.begin(-1, 0, 1)).toBe(false)
    expect(t.begin(1, 0, 1)).toBe(false) // single sheet can't turn either way
    expect(t.begin(1, 0, 0)).toBe(false)
    expect(t.phase).toBe('idle')
  })

  it('honours a caller-supplied canTurn predicate', () => {
    const t = createPageTurn({ canTurn: () => false })
    expect(t.begin(1, 0, 9)).toBe(false)
  })
})

describe('progress continuity across release and cancel', () => {
  for (const dir of [1, -1] as const) {
    for (const p of [0.2, 0.45, 0.7]) {
      it(`holds the exact dragged value ${p} (dir ${dir}) at the release frame`, () => {
        const t = createPageTurn()
        expect(t.begin(dir, 2, 5)).toBe(true)
        t.drag(p * dir)
        expect(t.progress).toBe(p)
        t.release(true)
        // The rendered progress at the release frame is the dragged value —
        // easing reshapes the segment's clock, not its start point.
        expect(t.progress).toBe(p)
        expect(t.tick(0)).toBe(p)
      })

      it(`holds the exact dragged value ${p} (dir ${dir}) into a cancel`, () => {
        const t = createPageTurn()
        t.begin(dir, 2, 5)
        t.drag(p * dir)
        t.release(false)
        expect(t.progress).toBe(p)
        expect(t.tick(0)).toBe(p)
      })
    }
  }
})

describe('dragging', () => {
  it('writes progress directly and clamps to 0..1', () => {
    const t = createPageTurn()
    t.begin(1, 2, 5)
    t.drag(0.3)
    expect(t.progress).toBe(0.3)
    t.drag(0.12)
    expect(t.progress).toBe(0.12)
    t.drag(1.4)
    expect(t.progress).toBe(1)
    t.drag(-0.5)
    // Negative input isn't the old direction dragged backwards — it's a
    // reversal attempt (see below), so progress never goes negative.
    expect(t.progress).toBe(0.5)
    expect(t.dir).toBe(-1)
  })

  it('reverses direction under the finger when the drag crosses zero', () => {
    const t = createPageTurn()
    t.begin(1, 2, 5)
    t.drag(0.6)
    expect(t.dir).toBe(1)
    t.drag(0)
    expect(t.progress).toBe(0)
    expect(t.dir).toBe(1) // at rest the chosen leaf stays armed
    t.drag(-0.25)
    expect(t.dir).toBe(-1)
    expect(t.dstIndex).toBe(1)
    expect(t.srcIndex).toBe(2)
    expect(t.progress).toBe(0.25)
    expect(t.leafIndex).toBe(1)
    // And back again.
    t.drag(0.4)
    expect(t.dir).toBe(1)
    expect(t.dstIndex).toBe(3)
    expect(t.progress).toBe(0.4)
  })

  it('reversing onto a missing sheet rests the leaf flat instead', () => {
    const t = createPageTurn()
    t.begin(1, 0, 5) // front sheet — nothing to pull back from
    t.drag(0.5)
    t.drag(-0.3)
    expect(t.dir).toBe(1)
    expect(t.progress).toBe(0)
    // The forward turn still works from there.
    t.drag(0.3)
    expect(t.progress).toBe(0.3)
  })
})

describe('settle / commit', () => {
  it('commits exactly once when settling reaches 1', () => {
    const results: string[] = []
    const t = createPageTurn({ onResult: (r) => results.push(r.type) })
    t.begin(1, 2, 5)
    t.drag(0.7)
    t.release(true)
    expect(t.phase).toBe('settling')
    expect(t.settleTarget).toBe(1)
    const p = settleOut(t)
    expect(p).toBe(1)
    expect(t.phase).toBe('idle')
    expect(t.leafIndex).toBeNull()
    expect(results).toEqual(['commit'])
    // The result is a one-shot slot: drain once, gone after.
    const r = t.takeResult()
    expect(r).toMatchObject({ type: 'commit', dir: 1, srcIndex: 2, dstIndex: 3, index: 3 })
    expect(t.takeResult()).toBeNull()
    // More frames don't re-fire.
    t.tick(1)
    expect(results).toEqual(['commit'])
  })

  it('settles to exactly 0 on cancel, keeps the source index, reports once', () => {
    const results: string[] = []
    const t = createPageTurn({ onResult: (r) => results.push(r.type) })
    t.begin(-1, 2, 5)
    t.drag(-0.35)
    t.release(false)
    expect(t.settleTarget).toBe(0)
    expect(settleOut(t)).toBe(0)
    expect(t.phase).toBe('idle')
    const r = t.takeResult()
    expect(r).toMatchObject({ type: 'cancel', dir: -1, srcIndex: 2, dstIndex: 1, index: 2 })
    expect(t.takeResult()).toBeNull()
    expect(results).toEqual(['cancel'])
  })

  it('release() with no argument commits past the threshold, cancels below', () => {
    const over = createPageTurn()
    over.begin(1, 2, 5)
    over.drag(0.5)
    over.release()
    expect(over.settleTarget).toBe(1)

    const under = createPageTurn()
    under.begin(1, 2, 5)
    under.drag(0.4)
    under.release()
    expect(under.settleTarget).toBe(0)
  })

  it('eases only the segment clock: half the segment lands at the midpoint', () => {
    const t = createPageTurn()
    t.begin(1, 2, 5)
    t.drag(0.5)
    t.release(true)
    // segDur = SETTLE_TIME * |1 - 0.5|; at half of it u = 0.5 and
    // easeInOut(0.5) = 0.5, so rendered progress sits at the segment's
    // midpoint — the ease never touches the 0.5 the finger left behind.
    expect(t.tick(SETTLE_TIME * 0.5 * 0.5)).toBeCloseTo(0.75)
    t.tick(0) // no time passes → no movement
    expect(t.progress).toBeCloseTo(0.75)
  })

  it('flip() runs a full turn without any finger input', () => {
    const cb = vi.fn()
    const t = createPageTurn({ onResult: cb })
    expect(t.flip(1, 0, 5)).toBe(true)
    expect(t.phase).toBe('settling')
    expect(settleOut(t)).toBe(1)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'commit', index: 1 }),
    )
  })

  it('flip() refuses at the bounds', () => {
    const t = createPageTurn()
    expect(t.flip(1, 4, 5)).toBe(false)
    expect(t.flip(-1, 0, 5)).toBe(false)
    expect(t.phase).toBe('idle')
  })
})

describe('single-transition policy', () => {
  it('rejects a second begin while dragging', () => {
    const t = createPageTurn()
    t.begin(1, 2, 5)
    t.drag(0.4)
    expect(t.begin(-1, 2, 5)).toBe(false)
    expect(t.begin(1, 2, 5)).toBe(false)
    expect(t.dir).toBe(1)
    expect(t.dstIndex).toBe(3)
    expect(t.progress).toBe(0.4)
  })

  it('rejects begin/flip while a settle is running', () => {
    const t = createPageTurn()
    t.begin(1, 2, 5)
    t.release(true)
    t.tick(0.05)
    expect(t.begin(-1, 2, 5)).toBe(false)
    expect(t.flip(-1, 2, 5)).toBe(false)
    expect(t.phase).toBe('settling')
    // The interrupted settle still lands and reports its own result.
    expect(settleOut(t)).toBe(1)
    expect(t.takeResult()?.type).toBe('commit')
  })

  it('ignores drag input once the finger has lifted', () => {
    const t = createPageTurn()
    t.begin(1, 2, 5)
    t.drag(0.5)
    t.release(true)
    t.tick(0.01)
    const p = t.progress
    t.drag(0.05) // a stray secondary pointer move
    expect(t.progress).toBe(p)
  })

  it('a second release cannot retarget a live settle', () => {
    const t = createPageTurn()
    t.begin(1, 2, 5)
    t.drag(0.6)
    t.release(true)
    t.release(false) // ignored — the turn is already committing
    expect(t.settleTarget).toBe(1)
    expect(settleOut(t)).toBe(1)
    expect(t.takeResult()?.type).toBe('commit')
  })

  it('accepts a new turn once the previous one finished', () => {
    const t = createPageTurn()
    t.begin(1, 2, 5)
    t.release(true)
    settleOut(t)
    expect(t.begin(-1, 3, 5)).toBe(true)
    expect(t.phase).toBe('dragging')
    expect(t.progress).toBe(0)
  })
})

describe('cancel', () => {
  it('while dragging: settles back to 0 from the dragged position', () => {
    const t = createPageTurn()
    t.begin(1, 2, 5)
    t.drag(0.3)
    t.cancel()
    expect(t.phase).toBe('settling')
    expect(t.settleTarget).toBe(0)
    expect(t.progress).toBe(0.3) // same rendered value — no snap
    expect(settleOut(t)).toBe(0)
    expect(t.takeResult()?.index).toBe(2)
  })

  it('mid-settle: redirects a committing turn back to 0 without a jump', () => {
    const t = createPageTurn()
    t.flip(1, 2, 5)
    t.tick(0.1)
    const p = t.progress
    expect(p).toBeGreaterThan(0)
    t.cancel()
    expect(t.settleTarget).toBe(0)
    expect(t.progress).toBe(p) // re-anchors at the rendered position
    expect(settleOut(t)).toBe(0)
    expect(t.takeResult()?.type).toBe('cancel')
  })

  it('is a no-op when idle', () => {
    const t = createPageTurn()
    t.cancel()
    expect(t.phase).toBe('idle')
    expect(t.takeResult()).toBeNull()
  })
})

describe('reset', () => {
  it('drops back to idle with no result', () => {
    const t = createPageTurn()
    t.begin(1, 2, 5)
    t.drag(0.6)
    t.reset()
    expect(t.phase).toBe('idle')
    expect(t.progress).toBe(0)
    expect(t.busy).toBe(false)
    expect(t.takeResult()).toBeNull()
    expect(t.begin(-1, 2, 5)).toBe(true)
  })
})
