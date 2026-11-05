export interface OrderedTextureJob {
  order: number
}

// Only rasterize textures for the representation currently on screen.
// Overview cards can be prepared when the user switches to that mode.
export function selectTextureJobs<T extends OrderedTextureJob>(
  mode: 'stack' | 'overview',
  stackJobs: T[],
  overviewJobs: T[],
): T[] {
  return [...(mode === 'stack' ? stackJobs : overviewJobs)].sort((a, b) => a.order - b.order)
}
