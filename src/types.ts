export interface Pt {
  x: number
  y: number
  t: number
  p: number // pressure 0..1
}

export interface Sample {
  x: number
  y: number
  w: number // half-width, px
  a: number // alpha 0..1
}

export type ToolId =
  | 'eraser'
  | 'draw'
  | 'sketch'
  | 'outline'
  | 'write'
  | 'color'
  | 'shapes'
  | 'fill'
  | 'cut'
  | 'move'
  | 'transform'

export type ShapeKind = 'rectangle' | 'ellipse' | 'line' | 'arrow' | 'triangle' | 'diamond'

export interface Stroke {
  tool: ToolId
  color: string
  pts: Pt[]
  size?: number
  layerId?: string
}

export interface PhotoItem {
  src: string // dataURL
  x: number
  y: number
  w: number
  h: number
}

// Raster/page ops replayed in order relative to strokes. `after` is the number
// of strokes already drawn when the op ran, so replay can interleave them.
export type PageOp =
  | ({ kind: 'fill'; x: number; y: number; color: string; after: number } & { layerId?: string })
  | ({ kind: 'cut'; path: { x: number; y: number }[]; dx: number; dy: number; after: number } & { layerId?: string })
  | ({ kind: 'photo'; photo: PhotoItem; after: number } & { layerId?: string })
  | ({ kind: 'clear'; after: number } & { layerId?: string })

export interface Layer {
  id: string
  name: string
  visible: boolean
  opacity: number
  x: number
  y: number
  scale: number
  rotation: number
}

export interface Page {
  id: string
  strokes: Stroke[]
  ops?: PageOp[]
  layers?: Layer[]
  activeLayerId?: string
  createdAt: number
}

export interface Journal {
  id: string
  title: string
  cover: number // cover color index
  coverImg?: string // custom cover photo (dataURL) — wins over `cover`
  pages: Page[]
  createdAt: number
}

export interface InkEngine {
  begin(tool: string): number
  addPoint(id: number, x: number, y: number, t: number, p: number): Sample[]
  end(id: number): Sample[]
}
