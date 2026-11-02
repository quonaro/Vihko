import * as THREE from 'three'
import type { InkEngine, Page } from '../types'
import {
  PAGE_W, PAGE_H, PAGE_STEP, sheetCameraDistance,
  rowPoseFocus, rowHoverFocus, canTurnStack, curlPoint,
  STACK_LEAN, stackPose, stackHoverPose, stackRestY,
  ROW_LEAN, rowRestY, sheetPoint,
  type Pose,
} from './layout'
import {
  rubberScroll, flickVelocity, momentumStep, MOMENTUM_MIN,
} from './gesture'
import { pageCanvas, repaintInto } from './pageTexture'
import {
  createRenderer, addStudioRig, createComposer, detectQuality, FramePump,
  gridEdgeLoop, outlineMaterial, type Quality,
} from './stage'
import { Line2 } from 'three/examples/jsm/lines/Line2.js'
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js'
import { onImageLoaded } from '../ink/ops'
import { shouldClearHoverOnCanvasLeave } from './hover'

export interface SceneEvents {
  onPageClick?: (id: string) => void
  // Hovered page + its top-right corner in canvas px (delete-button anchor).
  onHoverPage?: (id: string | null, anchor: { x: number; y: number } | null) => void
  // Anchor under each visible sheet in canvas px — touch devices have no
  // hover, so tappable sheets get a delete button below them instead.
  onSheetAnchors?: (list: { id: string; x: number; y: number }[]) => void
  onFlipDone?: (dir: 1 | -1) => void
}

const FLIP_TIME = 0.62
const TEX_W = 1024
// The free edge trails the spine mid-turn — a paper bend, not a plank.
const LEAF_CURL = 0.4

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
const damp = (rate: number, dt: number) => 1 - Math.exp(-rate * dt)

type PageMesh = THREE.Mesh<THREE.BoxGeometry, THREE.Material[]>
type PaperMaterial = THREE.MeshStandardMaterial
type LeafMesh = THREE.Mesh<THREE.PlaneGeometry, PaperMaterial>

interface PageEntry {
  mesh: PageMesh
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

export class JournalScene {
  private renderer: THREE.WebGLRenderer
  private stage: HTMLElement | null
  private post: ReturnType<typeof createComposer>
  private scene = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private raycaster = new THREE.Raycaster()
  private stackGroup = new THREE.Group()
  private texCache = new Map<string, TexEntry>()
  private sheets: PageEntry[] = []
  private turnFront!: LeafMesh
  private turnBack!: LeafMesh
  private edgeMat: PaperMaterial | null = null
  private inkMat = outlineMaterial()
  private bump: THREE.Texture | null = null
  private blankTex: THREE.Texture | null = null
  // Pages rasterize into textures a slice at a time after setPages — see tick.
  private texJobs: { mesh: PageMesh; page: Page }[] = []
  // Resolved once shaders are compiled and the initial texture queue has
  // drained; the view reveals the canvas after its first complete frame.
  readonly ready: Promise<void>
  private readyResolve!: () => void
  private compiled = false
  private readyDone = false
  private turnGroup = new THREE.Group()
  private turnBase!: Float32Array
  private turnOutline!: Line2
  private leafRing: number[] = []
  private mode: 'stack' | 'overview' = 'stack'
  private pages: Page[] = []
  // Front sheet index in the stack; stackPos trails it smoothly.
  private cur = 0
  private stackPos = 0
  // Sheet hidden under the turning leaf while a turn is in flight.
  private hideIdx: number | null = null
  private revealIdx: number | null = null
  private keepLeft = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0)
  private keepRight = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0)
  private hovered: PageEntry | null = null
  private lastHoverId: string | null = null
  // 'idle' → 'manual' (leaf follows the finger) → 'run' (finish the turn) or
  // 'cancel' (animate back onto its pile). 'run' is also entered directly
  // by button/wheel flips.
  private turnState: 'idle' | 'manual' | 'run' | 'cancel' = 'idle'
  private flipT = 0
  private flipDir: 1 | -1 = 1
  private drag: {
    id: number
    x0: number
    y0: number
    v0: number
    moved: boolean
    turnDir: number
  } | null = null
  private trail: { x: number; t: number }[] = []
  private vel = 0 // overview flick momentum, pages/s
  private clickWasDrag = false
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
  private lookPos = new THREE.Vector3()
  private lookTarget = new THREE.Vector3()

  constructor(
    private canvas: HTMLCanvasElement,
    private ink: InkEngine,
    private events: SceneEvents,
    q: Quality = detectQuality(),
  ) {
    this.stage = canvas.parentElement
    this.ready = new Promise((res) => { this.readyResolve = res })
    this.renderer = createRenderer(canvas, q)
    this.renderer.localClippingEnabled = true
    this.inkMat.opacity = 0.08
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
    this.turnGroup.rotation.x = STACK_LEAN
    this.turnGroup.position.set(0, stackRestY(), 0.006)
    this.scene.add(this.stackGroup, this.turnGroup)

    this.buildLeaf()
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
  }

  // --- construction -------------------------------------------------------

  // Paper has real thickness: a thin box whose edge catches the light —
  // the single biggest "actually rendered" cue at this scale.
  private pageBox() {
    const g = new THREE.BoxGeometry(PAGE_W, PAGE_H, 0.006, 64, 32, 1)
    const pos = g.attributes.position
    for (let i = 0; i < pos.count; i++) {
      const [x, y, z] = sheetPoint(pos.getX(i), pos.getY(i))
      pos.setXYZ(i, x, y, z + pos.getZ(i))
    }
    g.computeVertexNormals()
    return g
  }

  // Turning leaf stays a subdivided plane — the curl deforms it per frame.
  // x runs 0..w with the spine (the sheet's left edge) at local x = 0.
  private leafGeometry() {
    const g = new THREE.PlaneGeometry(PAGE_W / 2, PAGE_H, 32, 32)
    g.translate(PAGE_W / 4, 0, 0)
    return g
  }

  // The leaf can't use EdgesGeometry — that would freeze the border on the
  // flat rest pose while the curl deforms the mesh. A Line2 strip over the
  // grid's perimeter vertices stays glued to the edge as long as its
  // instanced segment buffer is re-mirrored each frame (see tick).
  private leafOutline(geo: THREE.PlaneGeometry) {
    const { widthSegments: sx, heightSegments: sy } = geo.parameters
    this.leafRing = gridEdgeLoop(sx, sy)
    const src = geo.attributes.position.array as Float32Array
    const pts = new Float32Array((this.leafRing.length + 1) * 3)
    for (let i = 0; i <= this.leafRing.length; i++) {
      const v = this.leafRing[i % this.leafRing.length] * 3
      pts[i * 3] = src[v]
      pts[i * 3 + 1] = src[v + 1]
      pts[i * 3 + 2] = src[v + 2]
    }
    const g = new LineGeometry()
    g.setPositions(pts)
    const line = new Line2(g, this.inkMat)
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
      color: map ? 0xffffff : 0xfdf9ef,
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

  // Box page: textured front (+z face, material index 4), paper back and
  // edges — so the leaf reads as a sheet, not a plane. The back face doubles
  // as the turned sheet's visible side on the left pile.
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

  private buildLeaf() {
    const turnGeo = this.leafGeometry()
    this.turnBase = (turnGeo.attributes.position.array as Float32Array).slice()
    this.turnFront = this.makeLeaf(null, THREE.FrontSide, turnGeo)
    this.turnBack = this.makeLeaf(null, THREE.BackSide, turnGeo.clone())
    const frontUv = turnGeo.attributes.uv
    const backUv = this.turnBack.geometry.attributes.uv
    for (let i = 0; i < frontUv.count; i++) {
      const u = frontUv.getX(i)
      frontUv.setX(i, 0.5 + u * 0.5)
      backUv.setX(i, (1 - u) * 0.5)
    }
    this.turnOutline = this.leafOutline(turnGeo)
    this.turnGroup.add(this.turnFront, this.turnBack, this.turnOutline)
    this.turnGroup.visible = false
  }

  // --- textures -----------------------------------------------------------

  private texFor(
    page: Page | null,
    fold?: boolean,
    edgeShade?: boolean,
  ): THREE.Texture | null {
    if (!page) return null
    const key = page.id + (fold ? 'f' : '') + (edgeShade ? 'e' : '')
    const hit = this.texCache.get(key)
    if (hit) return hit.tex
    const canvas = pageCanvas(page, this.ink, TEX_W, fold, edgeShade)
    if (!canvas) return null
    const tex = new THREE.CanvasTexture(canvas)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy())
    this.texCache.set(key, { tex, ctx: canvas.getContext('2d')!, page, fold, edgeShade })
    return tex
  }

  // Photos inside stroke ops may finish loading after the first paint.
  private refreshTextures() {
    this.pump.wake()
    const refreshed = new Set<string>()
    for (const e of this.texCache.values()) {
      const key = `${e.page.id}|${e.tex.image.width}`
      const forceBase = !refreshed.has(key)
      refreshed.add(key)
      repaintInto(
        e.ctx, e.tex.image as HTMLCanvasElement, e.page, this.ink,
        e.fold, e.edgeShade, forceBase,
      )
      e.tex.needsUpdate = true
    }
  }

  // --- public API ---------------------------------------------------------

  setMode(mode: 'stack' | 'overview') {
    this.pump.wake()
    this.mode = mode
    this.endTurn()
    this.hovered = null
    this.vel = 0
    this.stackPos = this.cur
    this.camHome.set(
      0,
      mode === 'stack' ? 0.5 : 0.55,
      mode === 'stack' ? sheetCameraDistance(this.camera.aspect) : 4.6,
    )
    this.lookTarget.set(0, mode === 'stack' ? -0.2 : -0.15, 0)
    if (mode === 'overview') {
      // Center the row on the sheet the stack was showing.
      this.rowTarget = this.cur - (this.sheets.length - 1) / 2
    }
  }

  setPage(idx: number) {
    this.pump.wake()
    this.endTurn()
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
    this.endTurn()
    this.pages = pages
    this.cur = Math.max(0, Math.min(pages.length - 1, this.cur))
    this.stackPos = Math.max(0, Math.min(pages.length - 1, this.stackPos))
    // (Re)build the sheet stack to match the page list.
    for (const p of this.sheets) {
      this.stackGroup.remove(p.mesh)
      p.mesh.traverse((o) => {
        if (o !== p.mesh && o instanceof THREE.Mesh) o.geometry.dispose()
      })
      p.mesh.geometry.dispose()
      p.mesh.material.forEach((m) => m.dispose())
    }
    this.sheets = []
    this.sheets = pages.map((page, i) => {
      const mesh = this.makePage(null)
      const pose = this.mode === 'stack' ? stackPose(i - this.cur) : rowPoseFocus(i, this.cur)
      mesh.position.set(pose.x, pose.y, pose.z)
      mesh.rotation.set(0, pose.rotY, pose.rotZ)
      mesh.userData.i = i
      this.stackGroup.add(mesh)
      return { mesh, id: page.id, page }
    })
    this.stackGroup.position.y = this.mode === 'stack' ? stackRestY() : rowRestY()
    this.stackGroup.rotation.x = this.mode === 'stack' ? STACK_LEAN : ROW_LEAN
    // Rasterizing N pages up front froze the journal-open animation, so
    // meshes go up as blank paper and the texture queue inks them a slice
    // per frame, starting from the sheet under the focus.
    const focus = this.mode === 'stack'
      ? this.stackPos
      : this.rowTarget + (pages.length - 1) / 2
    this.texJobs = this.sheets
      .slice()
      .sort((a, b) => Math.abs(a.mesh.userData.i - focus) - Math.abs(b.mesh.userData.i - focus))
      .map((e) => ({ mesh: e.mesh, page: e.page }))
    this.hovered = null
    const lim = (pages.length - 1) / 2
    this.rowTarget = Math.max(-lim, Math.min(lim, this.rowTarget))
    this.rowPos = Math.max(-lim, Math.min(lim, this.rowPos))
  }

  // Animated sheet turn. The leaf carries the source page on its front face;
  // its back is blank paper — turned sheets lie face-down on the left pile.
  flip(dir: 1 | -1): boolean {
    if (this.turnState !== 'idle' || this.mode !== 'stack') return false
    if (!this.beginFlip(dir)) return false
    this.flipT = 0
    this.turnState = 'run'
    return true
  }

  // Texture/hide setup shared by button flips and finger-driven turns.
  // Returns false when there is no sheet to turn in that direction.
  private beginFlip(dir: 1 | -1): boolean {
    this.pump.wake()
    const s = this.cur
    if (!canTurnStack(dir, s, this.pages.length)) return false
    const leafPage = dir > 0 ? this.pages[s] : this.pages[s - 1]
    if (!leafPage) return false

    const nextPage = dir > 0 ? this.pages[s + 1] : this.pages[s]
    this.turnFront.material.map = this.texFor(leafPage, true) ?? this.placeholder()
    this.turnBack.material.map = this.texFor(nextPage, true) ?? this.placeholder()
    this.turnFront.userData.id = leafPage.id

    // The leaf replaces its sheet mesh for the duration of the turn.
    this.hideIdx = dir > 0 ? s : s - 1
    this.revealIdx = this.hideIdx + 1
    const left = this.sheets[this.hideIdx].mesh
    const right = this.sheets[this.revealIdx].mesh
    for (const [mesh, plane] of [[left, this.keepLeft], [right, this.keepRight]] as const) {
      mesh.position.set(0, 0, 0)
      mesh.rotation.set(0, 0, 0)
      // Faces are unique; edge material is shared across sheets.
      for (const material of mesh.material.slice(4)) {
        material.clippingPlanes = [plane]
        material.clipShadows = true
      }
    }
    this.hovered = null

    this.flipDir = dir
    this.turnGroup.visible = true
    return true
  }

  private endTurn() {
    this.turnState = 'idle'
    this.turnGroup.visible = false
    for (const idx of [this.hideIdx, this.revealIdx]) {
      if (idx === null || !this.sheets[idx]) continue
      // Snap to the pile/front pose the leaf just covered — easing in from
      // the pre-turn rotation would flash the sheet face-up for a frame.
      const m = this.sheets[idx].mesh
      for (const material of m.material.slice(4)) material.clippingPlanes = null
      const pose = this.poseFor(idx)
      m.position.set(pose.x, pose.y, pose.z)
      m.rotation.set(0, pose.rotY, pose.rotZ)
      m.visible = true
    }
    this.hideIdx = null
    this.revealIdx = null
  }

  get busy() {
    return this.turnState !== 'idle'
  }

  dispose() {
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
        if (Array.isArray(m)) m.forEach((x) => x.dispose())
        else m.dispose()
      }
    })
    this.inkMat.dispose()
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
      () => { this.compiled = true; this.pump.wake() },
      () => { this.compiled = true; this.pump.wake() },
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
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    if (this.mode === 'stack') this.camHome.z = sheetCameraDistance(this.camera.aspect)
    // px → world at the row's camera distance; also the row drag gain.
    const halfW = Math.tan((this.camera.fov * Math.PI) / 360) * this.camHome.z * (w / h)
    this.worldPerPx = (2 * halfW) / w
    this.pump.wake()
  }

  // Row scroll: page indices travelled per px of finger movement.
  private get pxPerIndex() {
    return (this.worldPerPx / PAGE_STEP) * 1.35
  }

  private onPointerDown = (e: PointerEvent) => {
    this.pump.wake()
    if (this.drag || this.busy) return
    this.drag = {
      id: e.pointerId, x0: e.clientX, y0: e.clientY, v0: this.rowTarget,
      moved: false, turnDir: 0,
    }
    this.trail = [{ x: e.clientX, t: e.timeStamp }]
    this.vel = 0
    this.clickWasDrag = false
    this.canvas.setPointerCapture(e.pointerId)
  }

  private onPointerMove = (e: PointerEvent) => {
    this.pump.wake()
    const r = this.canvas.getBoundingClientRect()
    const x = e.clientX - r.left
    const y = e.clientY - r.top
    if (this.drag && e.pointerId === this.drag.id && e.buttons) {
      this.trail.push({ x: e.clientX, t: e.timeStamp })
      if (this.trail.length > 16) this.trail.shift()
      const dx = e.clientX - this.drag.x0
      if (Math.abs(dx) > 6) this.drag.moved = true
      if (this.drag.moved) {
        this.clickWasDrag = true
        this.hovered = null
        this.canvas.style.cursor = 'grabbing'
        if (this.mode === 'overview') {
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

  // Stack mode: once a decisively-horizontal drag is underway, grab the
  // next/previous leaf and let it track the finger (turnState 'manual').
  private dragTurn(e: PointerEvent, dx: number) {
    const drag = this.drag!
    if (this.turnState === 'idle' && !drag.turnDir) {
      const ady = Math.abs(e.clientY - drag.y0)
      if (Math.abs(dx) > 12 && Math.abs(dx) > ady * 1.3) {
        const dir = dx < 0 ? 1 : -1
        drag.turnDir = this.beginFlip(dir) ? dir : 2 // 2 = tried, no leaf there
        if (drag.turnDir !== 2) this.turnState = 'manual'
      }
    }
    if (this.turnState === 'manual') {
      const span = Math.max(140, this.canvas.getBoundingClientRect().width * 0.55)
      this.flipT = Math.min(0.98, Math.max(0, (-dx * this.flipDir - 12) / span))
    }
  }

  private onPointerUp = (e: PointerEvent) => this.endDrag(e, true)
  private onPointerCancel = (e: PointerEvent) => this.endDrag(e, false)

  private endDrag(e: PointerEvent, flick: boolean) {
    this.pump.wake()
    if (this.drag && e.pointerId !== this.drag.id) return // other finger lifted
    const pv = flick ? flickVelocity(this.trail, e.timeStamp) : 0
    if (this.drag && this.drag.moved && flick && this.mode === 'overview') {
      const lim = (this.sheets.length - 1) / 2
      this.vel = -flickVelocity(this.trail, e.timeStamp) * this.pxPerIndex
      this.rowTarget = Math.max(-lim, Math.min(lim, this.rowTarget))
    }
    if (this.turnState === 'manual') {
      // Past half-way — or a fast enough flick — completes the turn.
      const commit = flick && (this.flipT > 0.45 || (this.flipDir === 1 ? pv < -400 : pv > 400))
      this.turnState = commit ? 'run' : 'cancel'
    }
    this.drag = null
    this.trail = []
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId)
    this.canvas.style.cursor = ''
  }

  private onPointerLeave = (e: PointerEvent) => {
    if (!shouldClearHoverOnCanvasLeave(e.relatedTarget, this.stage)) return
    this.clearHover()
  }

  private onStageLeave = () => this.clearHover()

  private clearHover() {
    this.pump.wake()
    this.hovered = null
    this.canvas.style.cursor = ''
  }

  private onClick = (e: MouseEvent) => {
    if (this.clickWasDrag) {
      this.clickWasDrag = false
      return
    }
    this.pick(e.offsetX, e.offsetY)
    const id = this.hovered?.id
    if (id) this.events.onPageClick?.(id)
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

  private pick(x: number, y: number) {
    if (this.busy) {
      this.hovered = null
      return
    }
    this.raycaster.setFromCamera(this.ndc(x, y), this.camera)
    const hit = this.raycaster
      .intersectObjects(this.stackGroup.children, false)
      .filter((h) => h.object.visible)[0]
    const entry = hit ? this.sheets[hit.object.userData.i] : null
    this.hovered = entry
    this.canvas.style.cursor = entry ? 'pointer' : ''
  }

  // Effective stack focus: normally the damped front index; while a turn is
  // in flight it slides with the leaf so the pile eases into place.
  private effFocus(): number {
    if (this.turnState === 'idle') return this.stackPos
    const t = this.turnState === 'manual' ? this.flipT : easeInOut(this.flipT)
    return this.cur + t * this.flipDir
  }

  private poseFor(i: number): Pose {
    const entry = this.sheets[i]
    if (this.mode === 'overview') {
      const focus = this.rowPos + (this.sheets.length - 1) / 2
      return entry === this.hovered ? rowHoverFocus(i, focus) : rowPoseFocus(i, focus)
    }
    const d = i - this.effFocus()
    return entry === this.hovered ? stackHoverPose(d) : stackPose(d)
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
        const tex = this.texFor(job.page, true, true)
        if (tex) (job.mesh.material[4] as PaperMaterial).map = tex
      } while (this.texJobs.length && performance.now() - t0 < 8)
    }
    if (!this.readyDone && this.compiled && !this.texJobs.length) {
      this.readyDone = true
      this.readyResolve()
    }
    if (!this.readyDone) moving = true

    // Sheet-turn deformation. 'manual' tracks the finger raw; 'run' eases to
    // completion; 'cancel' plays it back onto the pile it came from.
    if (this.turnState !== 'idle') {
      moving = true
      if (this.turnState === 'run') this.flipT = Math.min(1, this.flipT + dt / FLIP_TIME)
      else if (this.turnState === 'cancel') this.flipT = Math.max(0, this.flipT - dt / (FLIP_TIME * 0.65))
      const t = this.turnState === 'manual' ? this.flipT : easeInOut(this.flipT)
      const pos = this.turnFront.geometry.attributes.position
      for (let i = 0; i < pos.count; i++) {
        const bx = this.turnBase[i * 3]
        const by = this.turnBase[i * 3 + 1]
        const [px, py, pz] = curlPoint(bx, by, PAGE_W / 2, t, this.flipDir, LEAF_CURL)
        pos.setXYZ(i, px, py, pz)
        this.turnBack.geometry.attributes.position.setXYZ(i, px, py, pz)
      }
      pos.needsUpdate = true
      this.turnFront.geometry.computeVertexNormals()
      this.turnBack.geometry.attributes.position.needsUpdate = true
      this.turnBack.geometry.computeVertexNormals()
      // Fat lines bake endpoints into an instanced buffer — mirror the
      // deformed ring so the leaf's ink border rides the curl.
      const buf = (this.turnOutline.geometry.attributes.instanceStart as THREE.InterleavedBufferAttribute).data
      const dst = buf.array as Float32Array
      const src = pos.array as Float32Array
      const ring = this.leafRing
      for (let k = 0; k < ring.length; k++) {
        const a = ring[k] * 3
        const b = ring[(k + 1) % ring.length] * 3
        dst[k * 6] = src[a]
        dst[k * 6 + 1] = src[a + 1]
        dst[k * 6 + 2] = src[a + 2]
        dst[k * 6 + 3] = src[b]
        dst[k * 6 + 4] = src[b + 1]
        dst[k * 6 + 5] = src[b + 2]
      }
      buf.needsUpdate = true
      if (this.turnState === 'run' && this.flipT >= 1) {
        this.cur += this.flipDir
        this.stackPos = this.cur
        this.endTurn()
        this.events.onFlipDone?.(this.flipDir)
      } else if (this.turnState === 'cancel' && this.flipT <= 0) {
        this.endTurn()
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

    // Sheet poses ease toward rest/hover targets.
    const k = damp(11, dt)
    for (let i = 0; i < n; i++) {
      const entry = this.sheets[i]
      const m = entry.mesh
      if (!m.visible) continue
      if (this.busy && (i === this.hideIdx || i === this.revealIdx)) continue
      const pose = this.poseFor(i)
      const d =
        Math.abs(pose.x - m.position.x) + Math.abs(pose.y - m.position.y) +
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

    // Camera: fixed per mode, damped toward its home on mode switches —
    // no pointer parallax (the flat look keeps the table still).
    const cd =
      Math.abs(this.camHome.x - this.camera.position.x) +
      Math.abs(this.camHome.y - this.camera.position.y) +
      Math.abs(this.camHome.z - this.camera.position.z)
    if (cd > 1e-3) moving = true
    this.camera.position.x += (this.camHome.x - this.camera.position.x) * damp(6, dt)
    this.camera.position.y += (this.camHome.y - this.camera.position.y) * damp(6, dt)
    this.camera.position.z += (this.camHome.z - this.camera.position.z) * damp(6, dt)
    this.lookPos.lerp(this.lookTarget, damp(6, dt))
    if (this.lookPos.distanceToSquared(this.lookTarget) > 1e-6) moving = true
    this.camera.lookAt(this.lookPos)
    const groupLean = this.mode === 'stack' ? STACK_LEAN : ROW_LEAN
    const groupRest = this.mode === 'stack' ? stackRestY() : rowRestY()
    if (Math.abs(groupLean - this.stackGroup.rotation.x) > 1e-3) moving = true
    this.stackGroup.rotation.x += (groupLean - this.stackGroup.rotation.x) * damp(8, dt)
    if (Math.abs(groupRest - this.stackGroup.position.y) > 1e-3) moving = true
    this.stackGroup.position.y += (groupRest - this.stackGroup.position.y) * damp(8, dt)
    this.turnGroup.position.y = this.stackGroup.position.y
    this.turnGroup.rotation.x = this.stackGroup.rotation.x

    // Emit hover + delete-button anchor.
    const id = this.hovered?.id ?? null
    let anchor: { x: number; y: number } | null = null
    if (id && this.hovered) {
      const v = new THREE.Vector3(PAGE_W * 0.47, PAGE_H * 0.47, 0)
      this.hovered.mesh.localToWorld(v)
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
          v.set(0, -PAGE_H * 0.56, 0)
          entry.mesh.localToWorld(v)
          v.project(this.camera)
          if (v.z >= 1) continue
          const x = ((v.x + 1) / 2) * r.width
          if (x < -40 || x > r.width + 40) continue
          list.push({ id: entry.id, x, y: ((1 - v.y) / 2) * r.height })
        }
      } else {
        // Stack mode: only the front sheet is fully tappable.
        const entry = this.sheets[Math.round(this.stackPos)]
        if (entry && entry.mesh.visible) {
          const v = new THREE.Vector3(0, -PAGE_H * 0.56, 0)
          entry.mesh.localToWorld(v)
          v.project(this.camera)
          if (v.z < 1) {
            list.push({
              id: entry.id,
              x: ((v.x + 1) / 2) * r.width,
              y: ((1 - v.y) / 2) * r.height,
            })
          }
        }
      }
      this.events.onSheetAnchors(list)
    }
    return moving
  }
}
