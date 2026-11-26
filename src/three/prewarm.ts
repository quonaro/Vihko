import { logger } from '../log'

const log = logger('warmup')

let started = false
// Let the first screen settle before competing with it for the main thread.
const START_DELAY = 500

// Pay the 3D warmup bill while nothing is on screen: the journal's lazy chunk
// plus the shader programs and studio env map its surface needs (see
// warmup.ts). Idempotent — every view can call it on mount.
export function scheduleSceneWarmup() {
  if (started) return
  started = true
  const run = () => {
    void import('./warmup')
      .then((mod) => mod.warmJournalSurface())
      .catch((e: unknown) => log.debug('3D warmup skipped', e))
  }
  window.setTimeout(() => {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(run, { timeout: 2500 })
    } else {
      window.setTimeout(run, START_DELAY)
    }
  }, START_DELAY)
}

// Test hook: allow the scheduler to run again in the same process.
export function resetSceneWarmup() {
  started = false
}
