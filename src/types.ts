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
  | 'filter'
  | 'move'
  | 'transform'

export type ShapeKind = 'rectangle' | 'ellipse' | 'line' | 'arrow' | 'triangle' | 'diamond'

// Texture stamp shapes for ink brushes. Absent/'round' = the solid outline
// fill; the rest stamp a procedural sprite along the stroke centerline.
export type BrushTip = 'round' | 'noise' | 'airbrush' | 'marker'

export const BRUSH_TIPS: BrushTip[] = ['round', 'noise', 'airbrush', 'marker']

export type CoverTexture = 'paper' | 'smooth' | 'comic'
export const COVER_TEXTURES: CoverTexture[] = ['paper', 'smooth', 'comic']

// Per-tool brush parameters (store.brush). A full snapshot lands on each
// stroke at draw time so replay never depends on current settings.
export interface BrushParams {
  size: number // multiplier, 0.25..4
  opacity: number // 0..1
  stab: number // stabilizer 0..1; -1 = tool default
  blend?: BlendMode // stroke blend; absent = source-over
  tip?: BrushTip
  spacing?: number // stamp spacing, fraction of the stamp diameter
  jitter?: number // 0..1 size/alpha randomness
  scatter?: number // 0..1 positional randomness along the normal
  angle?: number // 0 = fixed stamp angle, 1 = follows stroke direction
  wet?: number // watercolor pickup 0..1 (how much canvas color a dab lifts)
}

export interface Stroke {
  tool: ToolId
  color: string
  pts: Pt[]
  size?: number
  mask?: boolean // painted into the layer's alpha mask, not its content
  stab?: number // brush stabilizer 0..1 at draw time; -1/absent = tool default
  layerId?: string
  alphaLock?: boolean // painted while the layer's alpha lock was on
  // Brush snapshot (see BrushParams); absent fields use renderer defaults.
  opacity?: number
  blend?: BlendMode
  tip?: BrushTip
  spacing?: number
  jitter?: number
  scatter?: number
  angle?: number
  wet?: number
}

// A named brush preset offered in the tool panel (VI-22).
export interface BrushPreset {
  id: string
  name: string
  tool: ToolId
  params: BrushParams
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
// `alphaLock` marks ops committed while the layer's alpha lock was on.
export type PageOp =
  | ({ kind: 'fill'; x: number; y: number; color: string; after: number } & {
      layerId?: string
      alphaLock?: boolean
      invert?: boolean // background fill: paint the complement of the region
    })
  | ({ kind: 'cut'; path: { x: number; y: number }[]; dx: number; dy: number; after: number } & {
      layerId?: string
      alphaLock?: boolean
    })
  | ({ kind: 'photo'; photo: PhotoItem; after: number } & {
      layerId?: string
      alphaLock?: boolean
    })
  | ({ kind: 'clear'; after: number } & { layerId?: string; alphaLock?: boolean })
  // Magic-wand background removal: clears the contiguous color region at (x,y).
  | ({ kind: 'erase'; x: number; y: number; after: number } & {
      layerId?: string
      alphaLock?: boolean
    })
  // Pixel filters applied to the layer raster at this point in the op stream.
  | ({
      kind: 'filter'
      filter: FilterKind
      amount?: number
      brightness?: number
      contrast?: number
      saturation?: number
      after: number
    } & {
      layerId?: string
      alphaLock?: boolean
    })

export type FilterKind = 'blur' | 'sharpen' | 'adjust'
export const FILTER_KINDS: FilterKind[] = ['blur', 'sharpen', 'adjust']

// Symmetry modes (mirror across page-center axes) and drawing guides.
export type SymmetryMode = 'none' | 'v' | 'h' | 'xy'
export const SYMMETRY_MODES: SymmetryMode[] = ['none', 'v', 'h', 'xy']
export type GuideMode = 'off' | 'line' | 'arc'
export const GUIDE_MODES: GuideMode[] = ['off', 'line', 'arc']

// Layer blend modes — the globalCompositeOperation values offered in the
// layer panel. 'source-over' is the default ("Normal") and is not stored.
export type BlendMode =
  | 'source-over'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'soft-light'
  | 'darken'
  | 'lighten'
  | 'color-dodge'
  | 'color-burn'
  | 'difference'

export const BLEND_MODES: BlendMode[] = [
  'source-over',
  'multiply',
  'screen',
  'overlay',
  'soft-light',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'difference',
]

export interface Layer {
  id: string
  name: string
  visible: boolean
  opacity: number
  x: number
  y: number
  scale: number
  rotation: number
  blend?: BlendMode // compositing mode; absent = source-over
  alphaLock?: boolean // new paint stays inside the layer's existing alpha
  clip?: boolean // clipped to the alpha of the visible layer below
  mask?: boolean // layer has an alpha mask edited by mask:true strokes
}

export interface Page {
  id: string
  w?: number // page-units width; absent = canonical PAGE_W
  h?: number // page-units height; absent = canonical PAGE_H
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
  coverTexture?: CoverTexture // absent in older saves; defaults to paper
  pages: Page[]
  createdAt: number
}

export interface InkEngine {
  begin(tool: string, size?: number, stab?: number): number
  addPoint(id: number, x: number, y: number, t: number, p: number): Sample[]
  predict(id: number, x: number, y: number, t: number, p: number): Sample[]
  end(id: number): Sample[]
  // Pixel kernels (engine/px.go) operating on ImageData buffers in place.
  floodFill?(
    data: Uint8ClampedArray,
    w: number,
    h: number,
    x: number,
    y: number,
    r: number,
    g: number,
    b: number,
    tol: number,
    pr: number,
    pg: number,
    pb: number,
    athresh: number,
  ): number
  boxBlur?(data: Uint8ClampedArray, w: number, h: number, radius: number): void
  sharpen?(data: Uint8ClampedArray, w: number, h: number, amount: number): void
  adjust?(data: Uint8ClampedArray, brightness: number, contrast: number, saturation: number): void
  wetStroke?(
    data: Uint8ClampedArray,
    w: number,
    h: number,
    dabs: number[],
    r: number,
    g: number,
    b: number,
    pickup: number,
  ): void
  inverseFill?(
    data: Uint8ClampedArray,
    w: number,
    h: number,
    x: number,
    y: number,
    r: number,
    g: number,
    b: number,
    tol: number,
    pr: number,
    pg: number,
    pb: number,
    athresh: number,
  ): number
  eraseColor?(
    data: Uint8ClampedArray,
    w: number,
    h: number,
    x: number,
    y: number,
    tol: number,
  ): number
}
