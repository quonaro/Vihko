import { describe, expect, it } from 'vitest'
import { selectTextureJobs } from './textureQueue'

describe('selectTextureJobs', () => {
  it('queues only the active representation, nearest focus first', () => {
    const stack = [
      { id: 'far', order: 4 },
      { id: 'near', order: 0 },
    ]
    const overview = [{ id: 'card', order: 0.5 }]

    expect(selectTextureJobs('stack', stack, overview)).toEqual([stack[1], stack[0]])
    expect(selectTextureJobs('overview', stack, overview)).toEqual(overview)
  })
})
