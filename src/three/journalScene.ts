import * as THREE from 'three'
import type { InkEngine, Page } from '../types'
import {
  PAGE_W,
  PAGE_H,
  PAGE_STEP,
  sheetCameraDistance,
  HALF_W,
  rowPoseFocus,
  canTurnStack,
  leafTexU,
  STACK_LEAN,
  stackRestY,
  leafRestAngle,
  leafRestZ,
  leafRestFan,
  leafRestSink,
  leafTurnCurl,
  leafTurnHingeClearance,
  leafTurnLift,
  ROW_LEAN,
  rowRestY,
  sheetPoint,
  sheetOutline3D,
  packOutline,
  leafPointTheta,
  leafOutlineTheta,
  GROUND_Y,
  SHEET_OUTLINE_COLOR,
  SHEET_OUTLINE_OPACITY,
  SHEET_OUTLINE_PX,
  type Pose,
} from './layout'
import {
  rubberScroll,
  flickVelocity,
  momentumStep,
  MOMENTUM_MIN,
  pinchZoom,
  clampPan,
} from './gesture'
import { pageCanvas, repaintInto, SHEET_SHADE } from './pageTexture'
import { createPageTurn } from './pageTurn'
import {
  createRenderer,
  addStudioRig,
  createComposer,
  detectQuality,
  FramePump,
  outlineMaterial,
  type Quality,
} from './stage'
import { Line2 } from 'three/examples/jsm/lines/Line2.js'
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js'
import { onImageLoaded } from '../ink/ops'
import { logger } from '../log'
import { shouldClearHoverOnCanvasLeave } from './hover'

const log = logger('journal3d')

export interface SceneEvents {
  onPageClick?: (id: string) => void
  // Hovered page + its top-right corner in canvas px (delete-button anchor).
  onHoverPage?: (id: string | null, anchor: { x: number; y: number } | null) => void
  // Anchor under each visible sheet in canvas px — touch devices have no
  // hover, so tappable sheets get a delete button below them instead.
  onSheetAnchors?: (list: { id: string; x: number; y: number }[]) => void
  onFlipDone?: (dir: 1 | -1) => void
}

const TEX_W = 1024
// Touch delete buttons hang this far under a sheet's projected bottom
// edge — a px gap, so the 30px button stays clear of the paper at any zoom.
const DEL_DROP_PX = 40

const damp = (rate: number, dt: number) => 1 - Math.exp(-rate * dt)

type PageMesh = THREE.Mesh<THREE.BoxGeometry, THREE.Material[]>
type PaperMaterial = THREE.MeshStandardMaterial
type LeafMesh = THREE.Mesh<THREE.PlaneGeometry, PaperMaterial>

// One leaf = one half-sheet hinged at the centre spine (local x = 0, free
// edge at local x = HALF_W). Leaf k shows page k-1's right half on its front
// face and page k's left half on its back face, so spread `cur` is always
// leaf[cur].back + leaf[cur+1].front — and a page turn rotates one leaf,
// never hides or re-textures anything.
interface LeafEntry {
  front: LeafMesh
  back: LeafMesh
  outline: Line2
  rest: Float32Array // undeformed vertex xyz, shared by both face geos
  k: number
  theta: number
  hingeZ: number
  fan: number
  sink: number
  lift: number
  curl: number
}

interface PageEntry {
  mesh: PageMesh
  outline: Line2
  id: string
  page: Page
}

interface TexEntry {
  tex: THREE.CanvasTexture
  ctx: CanvasRenderingContext2D
  page: Page
  fold?: boolean
  edgeShade?: boolean
}

interface TexJob {
  mat: PaperMaterial
  page: Page
  order: number
  // Cards lie flat on the table — no painted centre crease on those.
  fold?: boolean
}

export class JournalScene {
  private renderer: THREE.WebGLRenderer
  private stage: HTMLElement | null
  private post: ReturnType<typeof createComposer>
  private scene = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private raycaster = new THREE.Raycaster()
  private stackGroup = new THREE.Group()
  private rowGroup = new THREE.Group()
  private texCache = new Map<string, TexEntry>()
  private sheets: PageEntry[] = [] // overview cards
  private leaves: LeafEntry[] = []
  private edgeMat: PaperMaterial | null = null
  private inkMat = outlineMaterial()
  // The spine crease gets its own material — always drawn, but softer than
  // the sheet outlines so it reads as a valley, not a border.
  private foldMat = outlineMaterial()
  private bump: THREE.Texture | null = null
  private blankTex: THREE.Texture | null = null
  // Pages rasterize into textures a slice at a time after setPages — see tick.
  private texJobs: TexJob[] = []
  // Resolved once shaders are compiled and the initial texture queue has
  // drained; the view reveals the canvas after its first complete frame.
  readonly ready: Promise<void>
  private readyResolve!: () => void
  private compiled = false
  private readyDone = false
  private mode: 'stack' | 'overview' = 'stack'
  private pages: Page[] = []
  // Front spread index; stackPos trails it smoothly for pile easing.
  private cur = 0
  private stackPos = 0
  private turn = createPageTurn({ canTurn: canTurnStack })
  private hoveredLeaf: LeafEntry | null = null
  private hoveredLeafHit: 'front' | 'back' | null = null
  private hoveredCard: PageEntry | null = null
  private lastHoverId: string | null = null
  private drag: {
    id: number
    x0: number
    y0: number
    v0: number
    pan0x: number
    pan0y: number
    moved: boolean
    turnDir: number
  } | null = null
  private trail: { x: number; t: number }[] = []
  private vel = 0 // overview flick momentum, pages/s
  private clickWasDrag = false
  // Pinch zoom: 1 = the mode's fit distance; the camera dollies toward the
  // look target by 1/zoom. `pan` is a screen-plane offset (x right, y up,
  // world units) applied to camera and look target together. Touches are
  // tracked separately from `drag` so a second finger can turn a
  // one-finger drag into a pinch mid-gesture.
  private zoom = 1
  private pan = new THREE.Vector2()
  private touches = new Map<number, { x: number; y: number }>()
  private pinch: { d0: number; zoom0: number; mx: number; my: number } | null = null
  // Focused page as an offset from the overview row centre, in page indices
  // (0 = centred); the rendered focus damps toward rowTarget.
  private rowTarget = 0
  private rowPos = 0
  private worldPerPx = 0.01
  private wheelAcc = 0
  private wheelT = 0
  private pump = new FramePump((now) => {
    const dt = Math.min((now - this.last) / 1000, 0.05)
    this.last = now
    const moving = this.tick(dt)
    this.post.render()
    return moving
  })
  private last = 0
  private unsubImages: () => void
  private ro: ResizeObserver
  private camHome = new THREE.Vector3()
  private effHome = new THREE.Vector3()
  private lookPos = new THREE.Vector3()
  private lookTarget = new THREE.Vector3()
  private tmpDir = new THREE.Vector3()
  private tmpRight = new THREE.Vector3()
  private tmpUp = new THREE.Vector3()
  private tmpLook = new THREE.Vector3()

  constructor(
    private canvas: HTMLCanvasElement,
    private ink: InkEngine,
    private events: SceneEvents,
    q: Quality = detectQuality(),
  ) {
    this.stage = canvas.parentElement
    this.ready = new Promise((res) => {
      this.readyResolve = res
    })
    this.renderer = createRenderer(canvas, q)
    this.inkMat.color.setHex(SHEET_OUTLINE_COLOR)
    this.inkMat.opacity = SHEET_OUTLINE_OPACITY
    this.inkMat.linewidth = SHEET_OUTLINE_PX
    this.foldMat.color.setHex(SHEET_OUTLINE_COLOR)
    this.foldMat.opacity = 0.3
    this.foldMat.linewidth = SHEET_OUTLINE_PX
    this.foldMat.transparent = true
    this.camera = new THREE.PerspectiveCamera(36, 1, 0.1, 50)
    this.camHome.set(0, 0.5, 4.6)
    this.camera.position.copy(this.camHome)
    this.lookTarget.set(0, -0.2, 0)
    this.lookPos.copy(this.lookTarget)
    addStudioRig(this.renderer, this.scene, -PAGE_H / 2 - 0.3, q)
    // The spread faces the viewer, unlike the shelf's standing book boards.
    // Light its front so the valley is shaded but the paper stays white.
    for (const light of this.scene.children) {
      if (light instanceof THREE.DirectionalLight && light.castShadow) {
        light.position.set(-3, 6, 5)
        light.intensity = 2
      }
    }
    this.post = createComposer(this.renderer, this.scene, this.camera, q)

    this.stackGroup.rotation.x = STACK_LEAN
    this.stackGroup.position.y = stackRestY()
    this.rowGroup.rotation.x = ROW_LEAN
    this.rowGroup.position.y = rowRestY()
    this.rowGroup.visible = false
    this.scene.add(this.stackGroup, this.rowGroup)
    this.buildFoldLine()

    this.unsubImages = onImageLoaded(() => this.refreshTextures())

    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointermove', this.onPointerMove)
    canvas.addEventListener('pointerup', this.onPointerUp)
    canvas.addEventListener('pointercancel', this.onPointerCancel)
    canvas.addEventListener('pointerleave', this.onPointerLeave)
    this.stage?.addEventListener('pointerleave', this.onStageLeave)
    canvas.addEventListener('click', this.onClick)
    canvas.addEventListener('wheel', this.onWheel, { passive: false })
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(canvas)
    this.resize()
    log.info('journal scene created', { quality: q })
  }

  // --- construction -------------------------------------------------------

  // Paper has real thickness: a thin box whose edge catches the light —
  // the single biggest "actually rendered" cue at this scale. Overview
  // cards stay flat (fold=false) — the valley belongs to the bound stack.
  private pageBox() {
    const g = new THREE.BoxGeometry(PAGE_W, PAGE_H, 0.006, 64, 32, 1)
    const pos = g.attributes.position
    for (let i = 0; i < pos.count; i++) {
      const [x, y, z] = sheetPoint(pos.getX(i), pos.getY(i), false)
      pos.setXYZ(i, x, y, z + pos.getZ(i))
    }
    g.computeVertexNormals()
    return g
  }

  // A leaf is a subdivided half-plane, hinge at local x = 0.
  private leafGeometry() {
    const g = new THREE.PlaneGeometry(HALF_W, PAGE_H, 32, 16)
    g.translate(HALF_W / 2, 0, 0)
    return g
  }

  private makeOutline(points: [number, number, number][], closed = true) {
    const g = new LineGeometry()
    g.setPositions(packOutline(points, closed))
    const line = new Line2(g, this.inkMat)
    // Clear the sheet's thin front face without disabling occlusion by
    // other sheets. The bias lives with this path, not the shared shelf rig.
    line.position.z = 0.006
    line.renderOrder = 2
    line.frustumCulled = false
    line.raycast = () => {}
    return line
  }

  private paperTexture(): THREE.Texture | null {
    if (this.bump !== null) return this.bump
    const c = document.createElement('canvas')
    c.width = c.height = 128
    const ctx = c.getContext('2d')
    if (!ctx) return null
    const img = ctx.createImageData(128, 128)
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 116 + ((Math.random() * 24) | 0)
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v
      img.data[i + 3] = 255
    }
    ctx.putImageData(img, 0, 0)
    const t = new THREE.CanvasTexture(c)
    t.wrapS = t.wrapT = THREE.RepeatWrapping
    t.repeat.set(5, 7)
    this.bump = t
    return t
  }

  // 1×1 white stand-in so every paper material compiles with USE_MAP from
  // the start — swapping in a real page texture later never recompiles the
  // program, which is what made texture pop-in hitch mid-animation.
  private placeholder(): THREE.Texture {
    if (!this.blankTex) {
      const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1)
      t.needsUpdate = true
      this.blankTex = t
    }
    return this.blankTex
  }

  // Paper stays matte — the flat look has no lacquer layer to shade.
  private pageMaterial(map: THREE.Texture | null, side: THREE.Side): PaperMaterial {
    const m = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.92,
      metalness: 0,
      bumpScale: 0.004,
      envMapIntensity: 0.35,
      side,
    })
    m.map = map ?? this.placeholder()
    const bump = this.paperTexture()
    if (bump) m.bumpMap = bump
    return m
  }

  private edges(): PaperMaterial {
    this.edgeMat ??= new THREE.MeshStandardMaterial({
      color: 0xe9e4d4,
      roughness: 0.92,
      envMapIntensity: 0.35,
    })
    return this.edgeMat
  }

  // Overview card: textured front (+z face, material index 4), paper back
  // and edges — the same thin box the stack used to show per page.
  private makePage(map: THREE.Texture | null) {
    const face = this.pageMaterial(map, THREE.FrontSide)
    const back = this.pageMaterial(null, THREE.FrontSide)
    const e = this.edges()
    const mesh = new THREE.Mesh(this.pageBox(), [e, e, e, e, face, back])
    mesh.castShadow = true
    mesh.receiveShadow = true
    return mesh as PageMesh
  }

  private makeLeaf(map: THREE.Texture | null, side: THREE.Side, geometry: THREE.PlaneGeometry) {
    const mesh = new THREE.Mesh(geometry, this.pageMaterial(map, side))
    mesh.castShadow = true
    mesh.receiveShadow = true
    return mesh as LeafMesh
  }

  // A faint crease line riding the spine between the two open halves —
  // static, so it stays put while a leaf pivots over it.
  private buildFoldLine() {
    const g = new LineGeometry()
    const pts: number[] = []
    for (let i = 0; i <= 16; i++) {
      const y = -PAGE_H / 2 + (PAGE_H * i) / 16
      pts.push(0, y, 0.004)
    }
    g.setPositions(pts)
    const line = new Line2(g, this.foldMat)
    line.renderOrder = 2
    line.frustumCulled = false
    line.raycast = () => {}
    this.stackGroup.add(line)
  }

  private buildLeaf(k: number): LeafEntry {
    const frontGeo = this.leafGeometry()
    const backGeo = frontGeo.clone()
    const rest = (frontGeo.attributes.position.array as Float32Array).slice()
    const frontUv = frontGeo.attributes.uv
    const backUv = backGeo.attributes.uv
    for (let i = 0; i < frontUv.count; i++) {
      const u = frontUv.getX(i)
      frontUv.setX(i, leafTexU('front', u))
      backUv.setX(i, leafTexU('back', u))
    }
    const front = this.makeLeaf(null, THREE.FrontSide, frontGeo)
    const back = this.makeLeaf(null, THREE.BackSide, backGeo)
    front.userData.page = this.pages[k - 1] ?? null
    back.userData.page = this.pages[k] ?? null
    const outline = this.makeOutline(leafOutlineTheta(0, 0))
    front.add(outline)
    this.stackGroup.add(front, back)
    return {
      front,
      back,
      outline,
      rest,
      k,
      theta: 0,
      hingeZ: 0,
      fan: 0,
      sink: 0,
      lift: 0,
      curl: 0,
    }
  }

  private deformLeaf(leaf: LeafEntry) {
    for (const geo of [leaf.front.geometry, leaf.back.geometry]) {
      const pos = geo.attributes.position
      const rest = leaf.rest
      for (let i = 0; i < pos.count; i++) {
        const [x, y, z] = leafPointTheta(
          rest[i * 3],
          rest[i * 3 + 1],
          HALF_W,
          leaf.theta,
          leaf.curl,
          leaf.fan,
          leaf.sink,
          leaf.lift,
        )
        pos.setXYZ(i, x, y, z)
      }
      pos.needsUpdate = true
      geo.computeVertexNormals()
      geo.computeBoundingSphere()
    }
    leaf.outline.geometry.setPositions(
      packOutline(leafOutlineTheta(leaf.theta, leaf.curl, leaf.fan, leaf.sink, leaf.lift)),
    )
    leaf.front.position.z = leaf.hingeZ
    leaf.back.position.z = leaf.hingeZ
  }

  // --- textures -----------------------------------------------------------

  private texFor(page: Page | null, fold?: boolean, edgeShade?: boolean): THREE.Texture | null {
    if (!page) return null
    const key = page.id + (fold ? 'f' : '') + (edgeShade ? 'e' : '')
    const hit = this.texCache.get(key)
    if (hit) return hit.tex
    const canvas = pageCanvas(page, this.ink, TEX_W, fold, edgeShade)
    if (!canvas) {
      log.debug('page texture raster unavailable', page.id)
      return null
    }
    const tex = new THREE.CanvasTexture(canvas)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.anisotropy = Math.min(16, this.renderer.capabilities.getMaxAnisotropy())
    this.texCache.set(key, { tex, ctx: canvas.getContext('2d')!, page, fold, edgeShade })
    return tex
  }

  // Photos inside stroke ops may finish loading after the first paint.
  private refreshTextures() {
    this.pump.wake()
    log.debug('refreshing page textures after image load', this.texCache.size)
    const refreshed = new Set<string>()
    for (const e of this.texCache.values()) {
      const key = `${e.page.id}|${e.tex.image.width}`
      const forceBase = !refreshed.has(key)
      refreshed.add(key)
      repaintInto(
        e.ctx,
        e.tex.image as HTMLCanvasElement,
        e.page,
        this.ink,
        e.fold,
        e.edgeShade,
        forceBase,
      )
      e.tex.needsUpdate = true
    }
  }

  // --- public API ---------------------------------------------------------

  setMode(mode: 'stack' | 'overview') {
    this.pump.wake()
    log.debug('scene mode', mode)
    this.mode = mode
    this.turn.reset()
    this.hoveredLeaf = this.hoveredCard = null
    this.vel = 0
    this.stackPos = this.cur
    this.camHome.set(
      0,
      mode === 'stack' ? 0.5 : GROUND_Y + sheetCameraDistance(this.camera.aspect),
      mode === 'stack' ? sheetCameraDistance(this.camera.aspect) : 0,
    )
    // Overview is a straight 90-degree top-down look at the tabletop.
    // up = -z so a sheet's far edge reads as the top of the screen.
    this.lookTarget.set(0, mode === 'stack' ? -0.2 : GROUND_Y, 0)
    this.camera.up.set(0, mode === 'stack' ? 1 : 0, mode === 'stack' ? 0 : -1)
    this.stackGroup.visible = mode === 'stack'
    this.rowGroup.visible = mode === 'overview'
    if (mode === 'overview') {
      // Center the row on the sheet the stack was showing.
      this.rowTarget = this.cur - (this.sheets.length - 1) / 2
    }
  }

  setPage(idx: number) {
    this.pump.wake()
    this.turn.reset()
    this.cur = Math.max(0, Math.min(this.pages.length - 1, idx))
    this.stackPos = this.cur
  }

  setOverviewFocus(index: number) {
    const lim = (this.sheets.length - 1) / 2
    this.rowTarget = Math.max(-lim, Math.min(lim, index - lim))
    this.rowPos = this.rowTarget
    this.pump.wake()
  }

  setPages(pages: Page[]) {
    this.pump.wake()
    this.turn.reset()
    log.debug('setPages', pages.length)
    this.pages = pages
    this.cur = Math.max(0, Math.min(pages.length - 1, this.cur))
    this.stackPos = Math.max(0, Math.min(pages.length - 1, this.stackPos))

    for (const leaf of this.leaves) {
      this.stackGroup.remove(leaf.front, leaf.back)
      leaf.front.geometry.dispose()
      leaf.back.geometry.dispose()
      leaf.front.material.dispose()
      leaf.back.material.dispose()
    }
    this.leaves = []
    // Leaf k is the hinge between spread k-1 (right half on its front) and
    // spread k (left half on its back): N spreads need N+1 leaves.
    for (let k = 0; k <= pages.length; k++) {
      const leaf = this.buildLeaf(k)
      leaf.theta = leafRestAngle(k, this.cur)
      leaf.hingeZ = leafRestZ(k, this.cur)
      leaf.fan = leafRestFan(k, this.cur)
      leaf.sink = leafRestSink(k, this.cur)
      leaf.lift = 0
      this.deformLeaf(leaf)
      this.leaves.push(leaf)
    }

    // Evict rasterized textures of pages that no longer exist — otherwise a
    // deleted page's texture lives until the whole scene is disposed.
    const alive = new Set(pages.map((p) => p.id))
    for (const [key, entry] of this.texCache) {
      if (entry.page && !alive.has(entry.page.id)) {
        entry.tex.dispose()
        this.texCache.delete(key)
        log.debug('evicted texture of a removed page', key)
      }
    }

    // (Re)build the overview card row to match the page list.
    for (const p of this.sheets) {
      this.rowGroup.remove(p.mesh)
      p.mesh.traverse((o) => {
        if (o !== p.mesh && o instanceof THREE.Mesh) o.geometry.dispose()
      })
      p.mesh.geometry.dispose()
      p.mesh.material.forEach((m) => {
        m.dispose()
      })
    }
    this.sheets = pages.map((page, i) => {
      const mesh = this.makePage(null)
      const outline = this.makeOutline(sheetOutline3D({}, false))
      mesh.add(outline)
      const pose = rowPoseFocus(i, this.cur)
      mesh.position.set(pose.x, pose.y, pose.z)
      mesh.rotation.set(0, pose.rotY, pose.rotZ)
      mesh.userData.i = i
      this.rowGroup.add(mesh)
      return { mesh, outline, id: page.id, page }
    })
    // Rasterizing N pages up front froze the journal-open animation, so
    // faces go up as blank paper and the texture queue inks them a slice
    // per frame, starting from the faces nearest the focus.
    const focus = this.mode === 'stack' ? this.stackPos : this.rowTarget + (pages.length - 1) / 2
    const jobs: TexJob[] = []
    for (const leaf of this.leaves) {
      const fp = leaf.front.userData.page as Page | null
      const bp = leaf.back.userData.page as Page | null
      if (fp) jobs.push({ mat: leaf.front.material, page: fp, order: Math.abs(leaf.k - 1 - focus) })
      if (bp) jobs.push({ mat: leaf.back.material, page: bp, order: Math.abs(leaf.k - focus) })
    }
    for (const e of this.sheets) {
      jobs.push({
        mat: e.mesh.material[4] as PaperMaterial,
        page: e.page,
        order: Math.abs(e.mesh.userData.i - focus) + 0.5,
        fold: false,
      })
    }
    this.texJobs = jobs.sort((a, b) => a.order - b.order)
    this.hoveredLeaf = this.hoveredCard = null
    const lim = (pages.length - 1) / 2
    this.rowTarget = Math.max(-lim, Math.min(lim, this.rowTarget))
    this.rowPos = Math.max(-lim, Math.min(lim, this.rowPos))
  }

  // A page turn is one leaf rotating across the spine. Leaf max(src,dst):
  // forward lifts the first upcoming leaf off the right pile, backward
  // pulls the boundary leaf back off the left pile.
  flip(dir: 1 | -1): boolean {
    if (this.mode !== 'stack' || !this.turn.flip(dir, this.cur, this.pages.length)) {
      log.debug('flip rejected', { dir, mode: this.mode, cur: this.cur })
      return false
    }
    log.debug('flip', { dir, from: this.cur })
    this.pump.wake()
    return true
  }

  get busy() {
    return this.turn.busy
  }

  dispose() {
    log.debug('journal scene disposed')
    this.texJobs = []
    this.pump.stop()
    this.ro.disconnect()
    this.unsubImages()
    this.canvas.removeEventListener('pointerdown', this.onPointerDown)
    this.canvas.removeEventListener('pointermove', this.onPointerMove)
    this.canvas.removeEventListener('pointerup', this.onPointerUp)
    this.canvas.removeEventListener('pointercancel', this.onPointerCancel)
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave)
    this.stage?.removeEventListener('pointerleave', this.onStageLeave)
    this.canvas.removeEventListener('click', this.onClick)
    this.canvas.removeEventListener('wheel', this.onWheel)
    for (const e of this.texCache.values()) e.tex.dispose()
    this.blankTex?.dispose()
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose()
        const m = o.material
        if (Array.isArray(m)) {
          m.forEach((x) => {
            x.dispose()
          })
        } else m.dispose()
      }
    })
    this.inkMat.dispose()
    this.foldMat.dispose()
    this.bump?.dispose()
    this.post.dispose()
    this.renderer.dispose()
  }

  start() {
    // Compile shader programs off the critical path where the driver
    // supports KHR_parallel_shader_compile; keep the canvas hidden until
    // `ready` resolves either way.
    const warm: Promise<unknown> | undefined = this.renderer.compileAsync?.(this.scene, this.camera)
    // Wake on resolution: if the pump already went idle, `ready` still has
    // to resolve one tick later so the view can reveal the canvas.
    Promise.resolve(warm).then(
      () => {
        this.compiled = true
        this.pump.wake()
      },
      () => {
        this.compiled = true
        this.pump.wake()
      },
    )
    this.last = performance.now()
    this.pump.start()
  }

  // --- per-frame ----------------------------------------------------------

  private resize() {
    const w = this.canvas.clientWidth || 2
    const h = this.canvas.clientHeight || 2
    this.renderer.setSize(w, h, false)
    this.post.setSize(w, h)
    this.inkMat.resolution.set(w, h)
    this.foldMat.resolution.set(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    if (this.mode === 'stack') {
      this.camHome.z = sheetCameraDistance(this.camera.aspect)
    } else {
      this.camHome.y = GROUND_Y + sheetCameraDistance(this.camera.aspect)
    }
    this.updateWorldPerPx()
    this.pump.wake()
  }

  // px → world at the camera's zoomed distance to the sheets; also the
  // row drag gain. Overview looks straight down, so that's height over
  // the table rather than z.
  private updateWorldPerPx() {
    const w = this.canvas.clientWidth || 2
    const h = this.canvas.clientHeight || 2
    const dist = (this.mode === 'stack' ? this.camHome.z : this.camHome.y - GROUND_Y) / this.zoom
    const halfW = Math.tan((this.camera.fov * Math.PI) / 360) * dist * (w / h)
    this.worldPerPx = (2 * halfW) / w
  }

  // Row scroll: page indices travelled per px of finger movement.
  private get pxPerIndex() {
    return (this.worldPerPx / PAGE_STEP) * 1.35
  }

  private onPointerDown = (e: PointerEvent) => {
    this.pump.wake()
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY })
    this.canvas.setPointerCapture(e.pointerId)
    if (this.touches.size === 2) {
      // A second finger converts any one-finger drag into a pinch.
      this.cancelDrag()
      const [a, b] = [...this.touches.values()]
      this.pinch = {
        d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        zoom0: this.zoom,
        mx: (a.x + b.x) / 2,
        my: (a.y + b.y) / 2,
      }
      this.clickWasDrag = true
      return
    }
    if (this.touches.size > 2 || this.pinch || this.drag || this.busy) return
    this.drag = {
      id: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      v0: this.rowTarget,
      pan0x: this.pan.x,
      pan0y: this.pan.y,
      moved: false,
      turnDir: 0,
    }
    this.trail = [{ x: e.clientX, t: e.timeStamp }]
    this.vel = 0
    this.clickWasDrag = false
  }

  private onPointerMove = (e: PointerEvent) => {
    this.pump.wake()
    const touch = this.touches.get(e.pointerId)
    if (touch) {
      touch.x = e.clientX
      touch.y = e.clientY
    }
    if (this.pinch && this.touches.size >= 2) {
      const [a, b] = [...this.touches.values()]
      this.zoom = pinchZoom(this.pinch.zoom0, this.pinch.d0, Math.hypot(a.x - b.x, a.y - b.y))
      this.updateWorldPerPx()
      // The midpoint's travel pans the view — incrementally, so the pan
      // keeps tracking the fingers while the px→world gain changes.
      const mx = (a.x + b.x) / 2
      const my = (a.y + b.y) / 2
      this.setPan(
        this.pan.x - (mx - this.pinch.mx) * this.worldPerPx,
        this.pan.y + (my - this.pinch.my) * this.worldPerPx,
      )
      this.pinch.mx = mx
      this.pinch.my = my
      return
    }
    const r = this.canvas.getBoundingClientRect()
    const x = e.clientX - r.left
    const y = e.clientY - r.top
    if (this.drag && e.pointerId === this.drag.id && e.buttons) {
      this.trail.push({ x: e.clientX, t: e.timeStamp })
      if (this.trail.length > 16) this.trail.shift()
      const dx = e.clientX - this.drag.x0
      const dy = e.clientY - this.drag.y0
      // While zoomed, a drag pans the view instead of turning/scrolling —
      // page turns stay on the ‹ › buttons until the pinch zooms back out.
      const panning = this.zoom > 1.05
      if (panning ? Math.hypot(dx, dy) > 6 : Math.abs(dx) > 6) this.drag.moved = true
      if (this.drag.moved) {
        this.clickWasDrag = true
        this.hoveredLeaf = this.hoveredCard = null
        this.canvas.style.cursor = 'grabbing'
        if (panning) {
          this.setPan(
            this.drag.pan0x - dx * this.worldPerPx,
            this.drag.pan0y + dy * this.worldPerPx,
          )
        } else if (this.mode === 'overview') {
          const lim = (this.sheets.length - 1) / 2
          this.rowTarget = rubberScroll(this.drag.v0 - dx * this.pxPerIndex, lim)
        } else {
          this.dragTurn(e, dx)
        }
        return
      }
    }
    this.pick(x, y)
  }

  // Pan is a screen-plane offset, clamped by the zoom-dependent limit —
  // at fit zoom the limit is zero, so the journal always recenters.
  private setPan(x: number, y: number) {
    const [cx, cy] = clampPan(x, y, this.zoom)
    this.pan.set(cx, cy)
  }

  // Stack mode: once a decisively-horizontal drag is underway, grab the
  // next/previous leaf and let it track the finger (turn phase 'dragging').
  private dragTurn(e: PointerEvent, dx: number) {
    const drag = this.drag!
    if (!this.busy && !drag.turnDir) {
      const ady = Math.abs(e.clientY - drag.y0)
      if (Math.abs(dx) > 12 && Math.abs(dx) > ady * 1.3) {
        const dir = dx < 0 ? 1 : -1
        drag.turnDir = this.turn.begin(dir, this.cur, this.pages.length) ? dir : 2
        log.debug('drag turn grabbed', { dir, grabbed: drag.turnDir === dir })
      }
    }
    if (this.turn.phase === 'dragging') {
      const span = Math.max(140, this.canvas.getBoundingClientRect().width * 0.55)
      const signed = (-Math.sign(dx) * Math.max(0, Math.abs(dx) - 12)) / span
      // Reversal under the finger swaps the live leaf inside the machine —
      // the leaf loop then drives the other boundary leaf instead, and the
      // released one simply eases back onto its pile.
      this.turn.drag(signed)
    }
  }

  private onPointerUp = (e: PointerEvent) => this.endDrag(e, true)
  private onPointerCancel = (e: PointerEvent) => this.endDrag(e, false)

  // Drop an in-progress one-finger gesture without flick — a second
  // finger arriving turns it into a pinch rather than a turn/flick.
  private cancelDrag() {
    if (this.turn.phase === 'dragging') this.turn.cancel()
    this.drag = null
    this.trail = []
    this.canvas.style.cursor = ''
  }

  private endDrag(e: PointerEvent, flick: boolean) {
    this.pump.wake()
    this.touches.delete(e.pointerId)
    if (this.canvas.hasPointerCapture(e.pointerId)) {
      this.canvas.releasePointerCapture(e.pointerId)
    }
    if (this.pinch) {
      // Rebase on the remaining pair or end the pinch under one finger —
      // which then pans while zoomed, continuing the same gesture.
      this.pinch = null
      if (this.touches.size >= 2) {
        const [a, b] = [...this.touches.values()]
        this.pinch = {
          d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
          zoom0: this.zoom,
          mx: (a.x + b.x) / 2,
          my: (a.y + b.y) / 2,
        }
      } else if (this.touches.size === 1 && this.zoom > 1.05 && !this.busy) {
        const [id, t] = [...this.touches.entries()][0]
        this.drag = {
          id,
          x0: t.x,
          y0: t.y,
          v0: this.rowTarget,
          pan0x: this.pan.x,
          pan0y: this.pan.y,
          moved: true,
          turnDir: 2,
        }
        this.trail = [{ x: t.x, t: e.timeStamp }]
      }
    }
    if (this.drag && e.pointerId !== this.drag.id) return // other finger lifted
    const pv = flick ? flickVelocity(this.trail, e.timeStamp) : 0
    if (this.drag?.moved && flick && this.mode === 'overview') {
      const lim = (this.sheets.length - 1) / 2
      this.vel = -flickVelocity(this.trail, e.timeStamp) * this.pxPerIndex
      this.rowTarget = Math.max(-lim, Math.min(lim, this.rowTarget))
    }
    if (this.turn.phase === 'dragging') {
      // Past half-way — or a fast enough flick — completes the turn.
      if (!flick) this.turn.cancel()
      else {
        const commit = this.turn.progress >= 0.45 || pv * this.turn.dir < -400
        log.debug('drag turn released', { commit, progress: this.turn.progress })
        this.turn.release(commit)
      }
    }
    this.drag = null
    this.trail = []
    this.canvas.style.cursor = ''
  }

  private onPointerLeave = (e: PointerEvent) => {
    if (!shouldClearHoverOnCanvasLeave(e.relatedTarget, this.stage)) return
    this.clearHover()
  }

  private onStageLeave = () => this.clearHover()

  private clearHover() {
    this.pump.wake()
    this.hoveredLeaf = this.hoveredCard = null
    this.canvas.style.cursor = ''
  }

  private onClick = (e: MouseEvent) => {
    if (this.clickWasDrag) {
      this.clickWasDrag = false
      return
    }
    this.pick(e.offsetX, e.offsetY)
    const id = this.mode === 'stack' ? this.hoveredLeafPageId() : (this.hoveredCard?.id ?? null)
    if (id) {
      log.debug('page picked', id)
      this.events.onPageClick?.(id)
    }
  }

  private onWheel = (e: WheelEvent) => {
    this.pump.wake()
    e.preventDefault()
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
    if (this.mode === 'overview') {
      this.vel = 0
      const lim = (this.sheets.length - 1) / 2
      this.rowTarget = Math.max(-lim, Math.min(lim, this.rowTarget + d * this.pxPerIndex * 1.2))
      return
    }
    // Stack: accumulate a decisive scroll, then turn one sheet.
    const now = e.timeStamp
    if (now - this.wheelT > 280) this.wheelAcc = 0
    this.wheelT = now
    this.wheelAcc = Math.max(-220, Math.min(220, this.wheelAcc + d))
    if (Math.abs(this.wheelAcc) > 60) {
      if (this.flip(this.wheelAcc > 0 ? 1 : -1)) this.wheelAcc = 0
    }
  }

  private ndc(x: number, y: number) {
    const r = this.canvas.getBoundingClientRect()
    return new THREE.Vector2((x / r.width) * 2 - 1, -(y / r.height) * 2 + 1)
  }

  private hoveredLeafPageId(): string | null {
    if (!this.hoveredLeaf) return null
    const hit = this.hoveredLeafHit
    if (!hit) return null
    const page =
      hit === 'front'
        ? (this.hoveredLeaf.front.userData.page as Page | null)
        : (this.hoveredLeaf.back.userData.page as Page | null)
    return page?.id ?? null
  }

  private pick(x: number, y: number) {
    if (this.busy) {
      this.hoveredLeaf = this.hoveredCard = null
      return
    }
    this.raycaster.setFromCamera(this.ndc(x, y), this.camera)
    if (this.mode === 'overview') {
      const hit = this.raycaster
        .intersectObjects(this.rowGroup.children, false)
        .filter((h) => h.object.visible)[0]
      this.hoveredCard = hit ? this.sheets[hit.object.userData.i] : null
      this.hoveredLeaf = null
      this.hoveredLeafHit = null
      this.canvas.style.cursor = this.hoveredCard ? 'pointer' : ''
      return
    }
    const hit = this.raycaster
      .intersectObjects(this.stackGroup.children, false)
      .filter((h) => h.object.visible)[0]
    this.hoveredCard = null
    if (hit && hit.object instanceof THREE.Mesh) {
      const leaf = this.leaves.find((l) => l.front === hit.object || l.back === hit.object)
      this.hoveredLeaf = leaf ?? null
      this.hoveredLeafHit = leaf ? (hit.object === leaf.front ? 'front' : 'back') : null
    } else {
      this.hoveredLeaf = null
      this.hoveredLeafHit = null
    }
    this.canvas.style.cursor = this.hoveredLeafPageId() ? 'pointer' : ''
  }

  // Rest-pose focus for non-turning leaves: while a turn settles the piles
  // pre-settle one depth toward the outcome; while dragging or idle they
  // just track the (damped) front index.
  private pileFocus(): number {
    return this.turn.phase === 'settling'
      ? this.turn.settleTarget === 1
        ? this.turn.dstIndex
        : this.turn.srcIndex
      : this.stackPos
  }

  private poseForCard(i: number): Pose {
    const focus = this.rowPos + (this.sheets.length - 1) / 2
    return rowPoseFocus(i, focus)
  }

  // Runs the scene one step and reports whether it is still moving — the
  // FramePump stops scheduling frames once nothing is, so an idle journal
  // costs zero GPU. Any event/mutation calls pump.wake() to resume.
  private tick(dt: number): boolean {
    let moving = false
    // Attach rasterized page textures a slice at a time — the first frames
    // after journal open would otherwise freeze on N synchronous repaints.
    if (this.texJobs.length) {
      moving = true
      const t0 = performance.now()
      do {
        const job = this.texJobs.shift()!
        const tex = this.texFor(job.page, job.fold ?? SHEET_SHADE.fold, SHEET_SHADE.edgeShade)
        if (tex) job.mat.map = tex
      } while (this.texJobs.length && performance.now() - t0 < 8)
    }
    if (!this.readyDone && this.compiled && !this.texJobs.length) {
      this.readyDone = true
      log.debug('scene ready: shaders compiled, textures attached')
      this.readyResolve()
    }
    if (!this.readyDone) moving = true

    if (this.busy) {
      moving = true
      this.turn.tick(dt)
      const result = this.turn.takeResult()
      if (result) {
        this.cur = result.index
        this.stackPos = this.cur
        if (result.type === 'commit') this.events.onFlipDone?.(result.dir)
      }
    }

    // Leaves: the turning leaf's angle is driven by turn progress; every
    // other leaf eases toward its rest angle — there is no hidden state,
    // the mesh the finger grabs is the mesh that lands.
    if (this.mode === 'stack') {
      const c = this.pileFocus()
      const tl = this.busy ? Math.max(this.turn.srcIndex, this.turn.dstIndex) : -1
      const k = damp(11, dt)
      for (const leaf of this.leaves) {
        let theta: number
        let hingeZ: number
        let fan: number
        let sink: number
        let lift: number
        let curl: number
        if (leaf.k === tl) {
          const t = this.turn.progress
          const a = leafRestAngle(leaf.k, this.turn.srcIndex)
          const b = leafRestAngle(leaf.k, this.turn.dstIndex)
          theta = a + (b - a) * t
          const za = leafRestZ(leaf.k, this.turn.srcIndex)
          const zb = leafRestZ(leaf.k, this.turn.dstIndex)
          hingeZ = za + (zb - za) * t + leafTurnHingeClearance(t)
          const fa = leafRestFan(leaf.k, this.turn.srcIndex)
          const fb = leafRestFan(leaf.k, this.turn.dstIndex)
          fan = fa + (fb - fa) * t
          const sa = leafRestSink(leaf.k, this.turn.srcIndex)
          const sb = leafRestSink(leaf.k, this.turn.dstIndex)
          sink = sa + (sb - sa) * t
          lift = leafTurnLift(t)
          curl = leafTurnCurl(t)
          leaf.theta = theta
          leaf.hingeZ = hingeZ
          leaf.fan = fan
          leaf.sink = sink
          leaf.lift = lift
          leaf.curl = curl
        } else {
          theta = leafRestAngle(leaf.k, c)
          hingeZ = leafRestZ(leaf.k, c)
          fan = leafRestFan(leaf.k, c)
          sink = leafRestSink(leaf.k, c)
          lift = 0
          const dTheta = theta - leaf.theta
          const dZ = hingeZ - leaf.hingeZ
          const dFan = fan - leaf.fan
          const dSink = sink - leaf.sink
          const dLift = lift - leaf.lift
          const dCurl = 0 - leaf.curl
          leaf.theta += dTheta * k
          leaf.hingeZ += dZ * k
          leaf.fan += dFan * k
          leaf.sink += dSink * k
          leaf.lift += dLift * k
          leaf.curl += dCurl * k
          if (
            Math.abs(dTheta) +
              Math.abs(dZ) +
              Math.abs(dFan) +
              Math.abs(dSink) +
              Math.abs(dLift) +
              Math.abs(dCurl) <
            1e-4
          )
            continue
        }
        this.deformLeaf(leaf)
        moving = true
      }
    }

    // Overview scroll: flick momentum carries the scroll target, and the
    // rendered row follows it smoothly.
    const n = this.sheets.length
    if (Math.abs(this.vel) > MOMENTUM_MIN && !this.drag) {
      moving = true
      const s = momentumStep(this.rowTarget, this.vel, (n - 1) / 2, dt)
      this.rowTarget = s.pos
      this.vel = s.vel
    }
    this.rowPos += (this.rowTarget - this.rowPos) * damp(10, dt)
    if (Math.abs(this.rowTarget - this.rowPos) > 1e-4) moving = true
    this.stackPos += (this.cur - this.stackPos) * damp(10, dt)
    if (Math.abs(this.cur - this.stackPos) > 1e-4) moving = true

    // Card poses ease toward rest/hover targets.
    if (this.mode === 'overview') {
      const k = damp(11, dt)
      for (let i = 0; i < n; i++) {
        const entry = this.sheets[i]
        const m = entry.mesh
        if (!m.visible) continue
        const pose = this.poseForCard(i)
        const d =
          Math.abs(pose.x - m.position.x) +
          Math.abs(pose.y - m.position.y) +
          Math.abs(pose.z - m.position.z) +
          Math.abs(pose.rotY - m.rotation.y) +
          Math.abs(pose.rotZ - m.rotation.z)
        if (d > 1e-3) moving = true
        m.position.x += (pose.x - m.position.x) * k
        m.position.y += (pose.y - m.position.y) * k
        m.position.z += (pose.z - m.position.z) * k
        m.rotation.y += (pose.rotY - m.rotation.y) * k
        m.rotation.z += (pose.rotZ - m.rotation.z) * k
      }
    }

    // Camera: fixed per mode, damped toward its home on mode switches —
    // no pointer parallax (the flat look keeps the table still). Pinch
    // zoom dollies along the look-axis: the effective home is camHome
    // lerped 1/zoom toward the look target, tracked tighter mid-pinch.
    const iz = 1 / this.zoom
    this.effHome.set(
      this.lookTarget.x + (this.camHome.x - this.lookTarget.x) * iz,
      this.lookTarget.y + (this.camHome.y - this.lookTarget.y) * iz,
      this.lookTarget.z + (this.camHome.z - this.lookTarget.z) * iz,
    )
    // Pan slides camera and look target together in the view plane —
    // screen-plane (x right, y up) → world via the camera basis.
    this.camera.getWorldDirection(this.tmpDir)
    this.tmpRight.crossVectors(this.tmpDir, this.camera.up).normalize()
    this.tmpUp.crossVectors(this.tmpRight, this.tmpDir).normalize()
    this.effHome.addScaledVector(this.tmpRight, this.pan.x).addScaledVector(this.tmpUp, this.pan.y)
    const lt = this.tmpLook
      .copy(this.lookTarget)
      .addScaledVector(this.tmpRight, this.pan.x)
      .addScaledVector(this.tmpUp, this.pan.y)
    const ck = damp(this.pinch ? 16 : 6, dt)
    const cd =
      Math.abs(this.effHome.x - this.camera.position.x) +
      Math.abs(this.effHome.y - this.camera.position.y) +
      Math.abs(this.effHome.z - this.camera.position.z)
    if (cd > 1e-3) moving = true
    this.camera.position.x += (this.effHome.x - this.camera.position.x) * ck
    this.camera.position.y += (this.effHome.y - this.camera.position.y) * ck
    this.camera.position.z += (this.effHome.z - this.camera.position.z) * ck
    this.lookPos.lerp(lt, ck)
    if (this.lookPos.distanceToSquared(lt) > 1e-6) moving = true
    this.camera.lookAt(this.lookPos)

    // Emit hover + delete-button anchor.
    const id = this.mode === 'stack' ? this.hoveredLeafPageId() : (this.hoveredCard?.id ?? null)
    let anchor: { x: number; y: number } | null = null
    if (id && this.mode === 'overview' && this.hoveredCard) {
      const v = new THREE.Vector3(PAGE_W * 0.47, PAGE_H * 0.47, 0)
      this.hoveredCard.mesh.localToWorld(v)
      v.project(this.camera)
      const r = this.canvas.getBoundingClientRect()
      anchor = { x: ((v.x + 1) / 2) * r.width, y: ((1 - v.y) / 2) * r.height }
    } else if (id && this.hoveredLeaf) {
      const p = leafPointTheta(
        HALF_W,
        PAGE_H * 0.47,
        HALF_W,
        this.hoveredLeaf.theta,
        this.hoveredLeaf.curl,
        this.hoveredLeaf.fan,
        this.hoveredLeaf.sink,
        this.hoveredLeaf.lift,
      )
      const v = new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(this.hoveredLeaf.front.matrixWorld)
      v.project(this.camera)
      const r = this.canvas.getBoundingClientRect()
      anchor = { x: ((v.x + 1) / 2) * r.width, y: ((1 - v.y) / 2) * r.height }
    }
    if (id !== this.lastHoverId || anchor) {
      this.events.onHoverPage?.(id, anchor)
      this.lastHoverId = id
    }

    if (this.events.onSheetAnchors) {
      const r = this.canvas.getBoundingClientRect()
      const list: { id: string; x: number; y: number }[] = []
      if (this.mode === 'overview') {
        const v = new THREE.Vector3()
        for (const entry of this.sheets) {
          v.set(0, -PAGE_H / 2, 0)
          entry.mesh.localToWorld(v)
          v.project(this.camera)
          if (v.z >= 1) continue
          const x = ((v.x + 1) / 2) * r.width
          if (x < -40 || x > r.width + 40) continue
          list.push({ id: entry.id, x, y: ((1 - v.y) / 2) * r.height + DEL_DROP_PX })
        }
      } else {
        // Stack mode: only the open spread is tappable — anchor under it.
        const entry = this.pages[Math.round(this.stackPos)]
        if (entry) {
          const v = new THREE.Vector3(0, -PAGE_H / 2, 0)
          this.stackGroup.localToWorld(v)
          v.project(this.camera)
          if (v.z < 1) {
            list.push({
              id: entry.id,
              x: ((v.x + 1) / 2) * r.width,
              y: ((1 - v.y) / 2) * r.height + DEL_DROP_PX,
            })
          }
        }
      }
      this.events.onSheetAnchors(list)
    }
    return moving
  }
}
