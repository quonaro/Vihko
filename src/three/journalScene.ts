import * as THREE from 'three'
import type { InkEngine, Page } from '../types'
import {
  PAGE_W, PAGE_H, PAGE_ASPECT, PAGE_STEP, COVER_W, COVER_H,
  rowPoseFocus, rowHoverFocus, canTurn, curlPoint, SPREAD_LEAN, SPREAD_TILT,
  bookFoldPose, spreadCameraDistance, spreadPageIndices, lastSpreadIndex,
} from './layout'
import {
  rubberScroll, flickVelocity, momentumStep, MOMENTUM_MIN, closesBookOnTurn,
  commitsBookCloseSwipe,
} from './gesture'
import { pageCanvas, repaintInto } from './pageTexture'
import {
  createRenderer, addStudioRig, createComposer, detectQuality, FramePump,
  addComicOutline, type Quality,
} from './stage'
import { getPhoto, onImageLoaded } from '../ink/ops'
import {
  coverCanvas, paintCover, dominantCoverColor, type CoverInput,
} from './coverTexture'
import {
  deviceTilt, deviceTiltRotation, shouldApplyJournalDeviceTilt, subscribeDeviceTilt,
} from './deviceTilt'
import { shouldClearHoverOnCanvasLeave } from './hover'

export interface SceneEvents {
  cover?: CoverInput
  onPageClick?: (id: string) => void
  // Hovered page + its top-right corner in canvas px (delete-button anchor).
  onHoverPage?: (id: string | null, anchor: { x: number; y: number } | null) => void
  // Anchor under each fan card in canvas px — touch devices have no hover,
  // so every page gets a delete button below it instead.
  onFanAnchors?: (list: { id: string; x: number; y: number }[]) => void
  onFlipDone?: (dir: 1 | -1) => void
  onCloseBook?: () => void
}

const FLIP_TIME = 0.62
const TEX_W = 512

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
const damp = (rate: number, dt: number) => 1 - Math.exp(-rate * dt)

type PageMesh = THREE.Mesh<THREE.BoxGeometry, THREE.Material[]>
// MeshPhysicalMaterial on the high tier, MeshStandardMaterial on low —
// typed as the shared base so pageMaterial can pick per quality tier.
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
  innerShadow?: 'left' | 'right'
  edgeShade?: boolean
}

export class JournalScene {
  private renderer: THREE.WebGLRenderer
  private stage: HTMLElement | null
  private post: ReturnType<typeof createComposer>
  private scene = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private raycaster = new THREE.Raycaster()
  private pointer = new THREE.Vector2(0, 0)
  private fanGroup = new THREE.Group()
  private bookGroup = new THREE.Group()
  private frontCover = new THREE.Group()
  private coverImageCanvas: HTMLCanvasElement | null = null
  private coverCtx: CanvasRenderingContext2D | null = null
  private coverTex: THREE.CanvasTexture | null = null
  private coverFace: PaperMaterial | null = null
  private coverInnerFace: PaperMaterial | null = null
  private backBoardMat: PaperMaterial | null = null
  private coverInput: CoverInput = { title: '', color: '#34343a' }
  private coverPhotoPending = false
  private foldT = 0
  private foldFrom = 0
  private foldTarget = 0
  private foldElapsed = 1
  private texCache = new Map<string, TexEntry>()
  private fanPages: PageEntry[] = []
  private left!: PageMesh
  private right!: PageMesh
  private turnFront!: LeafMesh
  private turnBack!: LeafMesh
  private edgeMat: PaperMaterial | null = null
  private inkMat = new THREE.LineBasicMaterial({
    color: 0x29231f,
    transparent: true,
    opacity: 0.82,
    depthWrite: false,
    toneMapped: false,
  })
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
  private mode: 'fan' | 'spread' = 'fan'
  private pages: Page[] = []
  private spread = 0
  private hovered: PageEntry | null = null
  private lastHoverId: string | null = null
  // 'idle' → 'manual' (leaf follows the finger) → 'run' (finish the turn) or
  // 'cancel' (animate back onto its stack). 'run' is also entered directly
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
    closeDir: 1 | -1 | 0
  } | null = null
  private trail: { x: number; t: number }[] = []
  private vel = 0 // fan flick momentum, pages/s
  private clickWasDrag = false
  // Focused page as an offset from the fan centre, in page indices
  // (0 = centred); the rendered focus damps toward fanTarget.
  private fanTarget = 0
  private fanPos = 0
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
  private unsubDeviceTilt: () => void
  private ro: ResizeObserver
  private camHome = new THREE.Vector3()

  constructor(
    private canvas: HTMLCanvasElement,
    private ink: InkEngine,
    private events: SceneEvents,
    private q: Quality = detectQuality(),
  ) {
    this.stage = canvas.parentElement
    this.coverInput = events.cover ?? this.coverInput
    this.ready = new Promise((res) => { this.readyResolve = res })
    this.renderer = createRenderer(canvas, q)
    this.camera = new THREE.PerspectiveCamera(36, 1, 0.1, 50)
    this.camHome.set(0, 0.1, 4.6)
    this.camera.position.copy(this.camHome)
    addStudioRig(this.renderer, this.scene, -PAGE_H / 2 - 0.3, q)
    this.post = createComposer(this.renderer, this.scene, this.camera, q)

    this.bookGroup.rotation.x = SPREAD_LEAN
    this.bookGroup.position.y = 0.06
    this.scene.add(this.fanGroup, this.bookGroup, this.turnGroup)

    this.buildBook()
    this.unsubImages = onImageLoaded(() => this.refreshTextures())
    this.unsubDeviceTilt = subscribeDeviceTilt(() => {
      if (this.mode === 'fan') this.pump.wake()
    })

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
  private pageBox(offsetX = 0) {
    const g = new THREE.BoxGeometry(PAGE_W, PAGE_H, 0.008)
    if (offsetX) g.translate(offsetX, 0, 0)
    return g
  }

  // Turning leaf stays a subdivided plane — the curl deforms it per frame.
  private leafGeometry() {
    const g = new THREE.PlaneGeometry(PAGE_W, PAGE_H, 48, 6)
    g.translate(PAGE_W / 2, 0, 0) // x runs 0..w, spine at local x=0
    return g
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

  private pageMaterial(map: THREE.Texture | null, side: THREE.Side): PaperMaterial {
    const params: THREE.MeshPhysicalMaterialParameters = {
      color: map ? 0xffffff : 0xfdf9ef,
      roughness: 0.82,
      metalness: 0,
      bumpScale: 0.004,
      envMapIntensity: 0.35,
      side,
    }
    // Low tier drops clearcoat — an extra BRDF lobe evaluated per pixel on
    // every paper surface is one of the priciest parts of this scene.
    const m = this.q === 'low'
      ? new THREE.MeshStandardMaterial(params)
      : new THREE.MeshPhysicalMaterial({ ...params, clearcoat: 0.07, clearcoatRoughness: 0.9 })
    m.map = map ?? this.placeholder()
    const bump = this.paperTexture()
    if (bump) m.bumpMap = bump
    return m
  }

  private edges(): PaperMaterial {
    this.edgeMat ??= this.q === 'low'
      ? new THREE.MeshStandardMaterial({
          color: 0xe9e4d4,
          roughness: 0.92,
          envMapIntensity: 0.35,
        })
      : new THREE.MeshPhysicalMaterial({
          color: 0xe9e4d4,
          roughness: 0.92,
          envMapIntensity: 0.35,
        })
    return this.edgeMat
  }

  // Box page: textured front (+z face, material index 4), paper back and
  // edges — so the leaf reads as a sheet, not a plane.
  private makePage(map: THREE.Texture | null, geometry?: THREE.BoxGeometry) {
    const face = this.pageMaterial(map, THREE.FrontSide)
    const back = this.pageMaterial(null, THREE.FrontSide)
    const e = this.edges()
    const mesh = new THREE.Mesh(geometry ?? this.pageBox(), [e, e, e, e, face, back])
    addComicOutline(mesh, this.inkMat)
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

  private buildBook() {
    this.coverImageCanvas = coverCanvas(this.coverInput)
    this.coverCtx = this.coverImageCanvas?.getContext('2d') ?? null
    this.coverPhotoPending = !!this.coverInput.coverImg && !getPhoto(this.coverInput.coverImg)
    if (this.coverImageCanvas && this.coverCtx) {
      this.coverTex = new THREE.CanvasTexture(this.coverImageCanvas)
      this.coverTex.colorSpace = THREE.SRGBColorSpace
      this.coverTex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy())
    }

    const edge = this.edges()
    const backBoardMat = this.pageMaterial(null, THREE.FrontSide)
    backBoardMat.color.set(dominantCoverColor(this.coverInput))
    this.backBoardMat = backBoardMat
    const backBoard = new THREE.Mesh(
      new THREE.BoxGeometry(PAGE_W, COVER_H, 0.035),
      [edge, edge, edge, edge, backBoardMat, backBoardMat],
    )
    backBoard.position.set(PAGE_W / 2, 0, -0.045)
    addComicOutline(backBoard, this.inkMat)
    backBoard.castShadow = true
    backBoard.receiveShadow = true
    this.bookGroup.add(backBoard)

    const coverFace = this.pageMaterial(this.coverTex, THREE.FrontSide)
    coverFace.color.set(this.coverTex ? 0xffffff : this.coverInput.color)
    coverFace.roughness = 0.62
    if (coverFace instanceof THREE.MeshPhysicalMaterial) coverFace.clearcoat = 0.32
    this.coverFace = coverFace
    const coverInnerFace = this.pageMaterial(null, THREE.FrontSide)
    coverInnerFace.color.set(dominantCoverColor(this.coverInput))
    this.coverInnerFace = coverInnerFace
    const coverGeo = new THREE.BoxGeometry(COVER_W, COVER_H, 0.035)
    // Keep the hinge at x=0; folding aligns this board to the page block.
    coverGeo.translate(-COVER_W / 2, 0, 0)
    const cover = new THREE.Mesh(coverGeo, [edge, edge, edge, edge, coverInnerFace, coverFace])
    cover.position.z = -0.045
    addComicOutline(cover, this.inkMat)
    cover.castShadow = true
    cover.receiveShadow = true
    this.frontCover.add(cover)
    this.bookGroup.add(this.frontCover)

    this.left = this.makePage(null, this.pageBox(-PAGE_W / 2))
    this.left.rotation.y = SPREAD_TILT

    this.right = this.makePage(null, this.pageBox(PAGE_W / 2))
    this.right.rotation.y = -SPREAD_TILT

    this.frontCover.add(this.left)
    this.bookGroup.add(this.right)
    this.bookGroup.visible = false

    const turnGeo = this.leafGeometry()
    this.turnBase = (turnGeo.attributes.position.array as Float32Array).slice()
    this.turnFront = this.makeLeaf(null, THREE.FrontSide, turnGeo)
    this.turnBack = this.makeLeaf(null, THREE.BackSide, turnGeo)
    this.turnGroup.add(this.turnFront, this.turnBack)
    this.turnGroup.rotation.x = SPREAD_LEAN
    this.turnGroup.position.y = 0.06
    this.turnGroup.visible = false
  }

  // --- textures -----------------------------------------------------------

  private texFor(
    page: Page | null,
    innerShadow?: 'left' | 'right',
    edgeShade?: boolean,
  ): THREE.Texture | null {
    if (!page) return null
    const key = page.id + (innerShadow ?? '') + (edgeShade ? 'e' : '')
    const hit = this.texCache.get(key)
    if (hit) return hit.tex
    const canvas = pageCanvas(page, this.ink, TEX_W, innerShadow, edgeShade)
    if (!canvas) return null
    const tex = new THREE.CanvasTexture(canvas)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy())
    this.texCache.set(key, { tex, ctx: canvas.getContext('2d')!, page, innerShadow, edgeShade })
    return tex
  }

  private mirrored(tex: THREE.Texture | null): THREE.Texture | null {
    if (!tex) return null
    const m = tex.clone()
    m.wrapS = THREE.RepeatWrapping
    m.repeat.x = -1
    m.offset.x = 1
    m.needsUpdate = true
    return m
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
        e.innerShadow, e.edgeShade, forceBase,
      )
      e.tex.needsUpdate = true
    }
    if (this.coverPhotoPending && this.coverImageCanvas && this.coverCtx && this.coverTex) {
      if (!this.coverInput.coverImg || !getPhoto(this.coverInput.coverImg)) return
      paintCover(this.coverImageCanvas, this.coverCtx, this.coverInput)
      this.coverTex.needsUpdate = true
      const innerColor = dominantCoverColor(this.coverInput)
      this.backBoardMat?.color.set(innerColor)
      this.coverInnerFace?.color.set(innerColor)
      this.coverPhotoPending = false
    }
  }

  // --- public API ---------------------------------------------------------

  setMode(mode: 'fan' | 'spread') {
    this.pump.wake()
    this.mode = mode
    this.fanGroup.visible = mode === 'fan'
    this.bookGroup.visible = mode === 'spread'
    this.turnGroup.visible = false
    this.turnState = 'idle'
    this.hovered = null
    this.vel = 0
    this.foldT = this.foldFrom = this.foldTarget = 0
    this.foldElapsed = 1
    this.frontCover.rotation.y = 0
    this.frontCover.position.z = 0
    this.left.rotation.y = SPREAD_TILT
    this.right.rotation.y = -SPREAD_TILT
    this.bookGroup.position.x = 0
    this.camHome.set(
      0,
      mode === 'fan' ? 0.1 : 0.35,
      mode === 'fan' ? 4.6 : spreadCameraDistance(this.camera.aspect),
    )
    // Restore halves a dropped/cancelled leaf may have revealed early.
    this.setSpread(this.spread)
    if (mode === 'fan') {
      // Center the horizontal page row on the page the spread was showing.
      this.fanTarget = this.spread - (this.fanPages.length - 1) / 2
    }
  }

  setBookClosed(closed: boolean) {
    if (this.mode !== 'spread') return
    const target = closed ? 1 : 0
    if (this.foldTarget === target && this.foldElapsed < 1) return
    if (this.foldT === target && this.foldElapsed >= 1) return
    this.foldFrom = this.foldT
    this.foldTarget = target
    this.foldElapsed = 0
    this.pump.wake()
  }

  setCover(input: CoverInput) {
    this.coverPhotoPending = !!input.coverImg && !getPhoto(input.coverImg)
    this.coverInput = input
    if (this.coverImageCanvas && this.coverCtx && this.coverTex && !this.coverPhotoPending) {
      paintCover(this.coverImageCanvas, this.coverCtx, input)
      this.coverTex.needsUpdate = true
    }
    if (this.coverFace) {
      this.coverFace.color.set(this.coverTex ? 0xffffff : input.color)
    }
    const innerColor = dominantCoverColor(input)
    this.backBoardMat?.color.set(innerColor)
    this.coverInnerFace?.color.set(innerColor)
    this.pump.wake()
  }

  setPages(pages: Page[]) {
    this.pump.wake()
    this.pages = pages
    this.spread = Math.min(this.spread, lastSpreadIndex(pages.length))
    // (Re)build the horizontal page row to match the page list.
    for (const p of this.fanPages) {
      this.fanGroup.remove(p.mesh)
      p.mesh.traverse((o) => {
        if (o instanceof THREE.LineSegments) o.geometry.dispose()
      })
      p.mesh.geometry.dispose()
      p.mesh.material.forEach((m) => m.dispose())
    }
    this.fanPages = pages.map((page, i) => {
      const mesh = this.makePage(null)
      const pose = rowPoseFocus(i, this.fanTarget + (pages.length - 1) / 2)
      mesh.position.set(pose.x, pose.y, pose.z)
      mesh.rotation.set(0, pose.rotY, pose.rotZ)
      mesh.userData.i = i
      this.fanGroup.add(mesh)
      return { mesh, id: page.id, page }
    })
    // Rasterizing N pages up front froze the journal-open animation, so
    // meshes go up as blank paper and the texture queue inks them a slice
    // per frame, starting from the page under the fan's focus.
    const focus = this.fanTarget + (pages.length - 1) / 2
    this.texJobs = this.fanPages
      .slice()
      .sort((a, b) => Math.abs(a.mesh.userData.i - focus) - Math.abs(b.mesh.userData.i - focus))
      .map((e) => ({ mesh: e.mesh, page: e.page }))
    this.hovered = null
    const lim = (pages.length - 1) / 2
    this.fanTarget = Math.max(-lim, Math.min(lim, this.fanTarget))
    this.fanPos = Math.max(-lim, Math.min(lim, this.fanPos))
    this.setSpread(this.spread)
  }

  setSpread(idx: number) {
    this.pump.wake()
    this.spread = Math.max(0, Math.min(lastSpreadIndex(this.pages.length), idx - idx % 2))
    const pages = spreadPageIndices(this.spread, this.pages.length)
    this.setHalf(this.left, pages.left === null ? null : this.pages[pages.left], 'right')
    this.setHalf(this.right, pages.right === null ? null : this.pages[pages.right], 'left')
  }

  setFanFocus(index: number) {
    const lim = (this.fanPages.length - 1) / 2
    this.fanTarget = Math.max(-lim, Math.min(lim, index - lim))
    this.fanPos = this.fanTarget
    this.pump.wake()
  }

  private setHalf(
    mesh: PageMesh,
    page: Page | null,
    spine: 'left' | 'right',
  ) {
    // Front face of the box is material index 4. The placeholder keeps
    // USE_MAP stable, so no needsUpdate / program recompile here.
    const face = mesh.material[4] as PaperMaterial
    face.map = this.texFor(page, page ? spine : undefined) ?? this.placeholder()
    mesh.visible = !!page
    mesh.userData.id = page?.id
  }

  // Animated page turn. Textures swap at start/end so the leaf carries the
  // source page on its start-facing side and the destination on the other.
  flip(dir: 1 | -1): boolean {
    if (this.turnState !== 'idle' || this.mode !== 'spread' || this.foldT > 0 || this.foldTarget > 0) return false
    if (!this.beginFlip(dir)) return false
    this.flipT = 0
    this.turnState = 'run'
    return true
  }

  // Texture/reveal setup shared by button flips and finger-driven turns.
  // Returns false when there is no leaf to turn in that direction.
  private beginFlip(dir: 1 | -1): boolean {
    this.pump.wake()
    const s = this.spread
    if (!canTurn(dir, s, this.pages.length)) return false
    const at = (i: number) => this.pages[i] ?? null
    const current = spreadPageIndices(s, this.pages.length)
    const sourceIndex = dir > 0 ? current.right : current.left
    const source = sourceIndex === null ? null : at(sourceIndex)
    const dest = dir > 0 ? at(s + 1) : at(s - 2)
    const reveal = dir > 0 ? at(s + 2) : at(s - 3)
    if (!source) return false

    this.turnFront.material.map = (dir > 0
      ? this.texFor(source, 'left')
      : this.texFor(dest, dest ? 'left' : undefined)) ?? this.placeholder()
    this.turnBack.material.map = (dir > 0
      ? this.mirrored(this.texFor(dest, dest ? 'right' : undefined))
      : this.mirrored(this.texFor(source, 'right'))) ?? this.placeholder()
    this.turnFront.userData.id = source.id

    // Reveal what's under the leaf immediately.
    if (dir > 0) this.setHalf(this.right, reveal, 'left')
    else this.setHalf(this.left, reveal, 'right')

    this.flipDir = dir
    this.turnGroup.visible = true
    return true
  }

  get busy() {
    return this.turnState !== 'idle' || this.foldElapsed < 1
  }

  dispose() {
    this.texJobs = []
    this.pump.stop()
    this.ro.disconnect()
    this.unsubImages()
    this.unsubDeviceTilt()
    this.canvas.removeEventListener('pointerdown', this.onPointerDown)
    this.canvas.removeEventListener('pointermove', this.onPointerMove)
    this.canvas.removeEventListener('pointerup', this.onPointerUp)
    this.canvas.removeEventListener('pointercancel', this.onPointerCancel)
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave)
    this.stage?.removeEventListener('pointerleave', this.onStageLeave)
    this.canvas.removeEventListener('click', this.onClick)
    this.canvas.removeEventListener('wheel', this.onWheel)
    for (const e of this.texCache.values()) e.tex.dispose()
    this.coverTex?.dispose()
    this.blankTex?.dispose()
    this.scene.traverse((o) => {
      if (o instanceof THREE.LineSegments) o.geometry.dispose()
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
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    if (this.mode === 'spread') this.camHome.z = spreadCameraDistance(this.camera.aspect)
    // px → world at the row's camera distance; also the row drag gain.
    const halfW = Math.tan((this.camera.fov * Math.PI) / 360) * 4.6 * (w / h)
    this.worldPerPx = (2 * halfW) / w
    this.pump.wake()
  }

  // Row scroll: page indices travelled per px of finger movement.
  private get pxPerIndex() {
    return (this.worldPerPx / PAGE_STEP) * 1.35
  }

  private onPointerDown = (e: PointerEvent) => {
    this.pump.wake()
    if (this.mode === 'spread' && (
      this.foldT > 0 || this.foldTarget > 0 || this.foldElapsed < 1
    )) return
    if (this.drag) return // a second finger must not rebase the gesture
    this.drag = {
      id: e.pointerId, x0: e.clientX, y0: e.clientY, v0: this.fanTarget,
      moved: false, turnDir: 0, closeDir: 0,
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
    this.pointer.set((x / r.width) * 2 - 1, -((y / r.height) * 2 - 1))
    if (this.drag && e.pointerId === this.drag.id && e.buttons) {
      this.trail.push({ x: e.clientX, t: e.timeStamp })
      if (this.trail.length > 16) this.trail.shift()
      const dx = e.clientX - this.drag.x0
      if (Math.abs(dx) > 6) this.drag.moved = true
      if (this.drag.moved) {
        this.clickWasDrag = true
        this.hovered = null
        this.canvas.style.cursor = 'grabbing'
        if (this.mode === 'fan') {
          const lim = (this.fanPages.length - 1) / 2
          this.fanTarget = rubberScroll(this.drag.v0 - dx * this.pxPerIndex, lim)
        } else {
          this.dragTurn(e, dx)
        }
        return
      }
    }
    this.pick(x, y)
    if (this.mode === 'spread') {
      this.canvas.style.cursor = this.pickBook(x, y) ? 'pointer' : ''
    }
  }

  // Spread mode: once a decisively-horizontal drag is underway, grab the
  // next/previous leaf and let it track the finger (turnState 'manual').
  private dragTurn(e: PointerEvent, dx: number) {
    const drag = this.drag!
    if (this.turnState === 'idle' && !drag.turnDir) {
      const ady = Math.abs(e.clientY - drag.y0)
      if (Math.abs(dx) > 12 && Math.abs(dx) > ady * 1.3) {
        const dir = dx < 0 ? 1 : -1
        drag.turnDir = this.beginFlip(dir) ? dir : 2 // 2 = tried, no leaf there
        if (drag.turnDir !== 2) this.turnState = 'manual'
        else if (closesBookOnTurn(dir, this.spread, this.pages.length)) drag.closeDir = dir
      }
    }
    if (this.turnState === 'manual') {
      const span = Math.max(140, this.canvas.getBoundingClientRect().width * 0.55)
      this.flipT = Math.min(0.98, Math.max(0, (Math.abs(dx) - 12) / span))
    }
  }

  private onPointerUp = (e: PointerEvent) => this.endDrag(e, true)
  private onPointerCancel = (e: PointerEvent) => this.endDrag(e, false)

  private endDrag(e: PointerEvent, flick: boolean) {
    this.pump.wake()
    if (this.drag && e.pointerId !== this.drag.id) return // other finger lifted
    const drag = this.drag
    const dx = drag ? e.clientX - drag.x0 : 0
    const pv = flick ? flickVelocity(this.trail, e.timeStamp) : 0
    if (this.drag && this.drag.moved && flick && this.mode === 'fan') {
      const lim = (this.fanPages.length - 1) / 2
      this.vel = -flickVelocity(this.trail, e.timeStamp) * this.pxPerIndex
      this.fanTarget = Math.max(-lim, Math.min(lim, this.fanTarget))
    }
    if (this.turnState === 'manual') {
      // Past half-way — or a fast enough flick — completes the turn.
      const commit = this.flipT > 0.45 || (this.flipDir === 1 ? pv < -400 : pv > 400)
      this.turnState = commit ? 'run' : 'cancel'
    } else if (drag?.closeDir) {
      const width = this.canvas.getBoundingClientRect().width
      if (flick && commitsBookCloseSwipe(drag.closeDir, dx, pv, width)) {
        this.events.onCloseBook?.()
      }
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
    const id = this.hovered?.id ?? this.pickBook(e.offsetX, e.offsetY)
    if (id) this.events.onPageClick?.(id)
  }

  private onWheel = (e: WheelEvent) => {
    this.pump.wake()
    e.preventDefault()
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
    if (this.mode === 'fan') {
      this.vel = 0
      const lim = (this.fanPages.length - 1) / 2
      this.fanTarget = Math.max(-lim, Math.min(lim, this.fanTarget + d * this.pxPerIndex * 1.2))
      return
    }
    // Spread: accumulate a decisive scroll, then turn one page.
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
    if (this.mode !== 'fan') {
      this.hovered = null
      return
    }
    this.raycaster.setFromCamera(this.ndc(x, y), this.camera)
    const hit = this.raycaster.intersectObjects(this.fanGroup.children, false)[0]
    const entry = hit ? this.fanPages[hit.object.userData.i] : null
    this.hovered = entry
    this.canvas.style.cursor = entry ? 'pointer' : ''
  }

  private pickBook(x: number, y: number): string | null {
    if (this.mode !== 'spread' || this.turnState !== 'idle' || this.foldT > 0 || this.foldTarget > 0) return null
    this.raycaster.setFromCamera(this.ndc(x, y), this.camera)
    const hit = this.raycaster.intersectObjects([this.left, this.right], false)[0]
    return (hit?.object.userData.id as string) ?? null
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
        const tex = this.texFor(job.page, undefined, true)
        if (tex) (job.mesh.material[4] as PaperMaterial).map = tex
      } while (this.texJobs.length && performance.now() - t0 < 8)
    }
    if (!this.readyDone && this.compiled && !this.texJobs.length) {
      this.readyDone = true
      this.readyResolve()
    }
    if (!this.readyDone) moving = true

    if (this.foldElapsed < 1) {
      this.foldElapsed = Math.min(1, this.foldElapsed + dt / 0.7)
      const t = easeInOut(this.foldElapsed)
      this.foldT = this.foldFrom + (this.foldTarget - this.foldFrom) * t
      const pose = bookFoldPose(this.foldT)
      this.frontCover.rotation.y = pose.coverY
      this.frontCover.position.z = pose.coverZ
      this.bookGroup.position.x = pose.centerX
      if (this.foldElapsed >= 1) this.foldT = this.foldTarget
      moving = true
    }

    // Page-row focus: flick momentum carries the scroll target, and the
    // rendered row follows it smoothly.
    const n = this.fanPages.length
    if (Math.abs(this.vel) > MOMENTUM_MIN && !this.drag) {
      moving = true
      const s = momentumStep(this.fanTarget, this.vel, (n - 1) / 2, dt)
      this.fanTarget = s.pos
      this.vel = s.vel
    }
    this.fanPos += (this.fanTarget - this.fanPos) * damp(10, dt)
    if (Math.abs(this.fanTarget - this.fanPos) > 1e-4) moving = true
    const focus = this.fanPos + (n - 1) / 2

    // Fan poses ease toward rest/hover targets.
    const k = damp(11, dt)
    const useDeviceTilt = shouldApplyJournalDeviceTilt(deviceTilt.active, this.mode)
    const sensorX = useDeviceTilt ? deviceTilt.x : 0
    const sensorY = useDeviceTilt ? deviceTilt.y : 0
    const tilt = deviceTiltRotation(sensorX, sensorY, 0.2)
    const tiltX = tilt.rotX
    const tiltY = tilt.rotY
    for (let i = 0; i < n; i++) {
      const entry = this.fanPages[i]
      const m = entry.mesh
      const pose = entry === this.hovered
        ? rowHoverFocus(i, focus)
        : rowPoseFocus(i, focus)
      const rotX = tiltX
      const d =
        Math.abs(pose.x - m.position.x) + Math.abs(pose.y - m.position.y) +
        Math.abs(pose.z - m.position.z) + Math.abs(rotX - m.rotation.x) +
        Math.abs(pose.rotY + tiltY - m.rotation.y) +
        Math.abs(pose.rotZ - m.rotation.z)
      if (d > 1e-3) moving = true
      m.position.x += (pose.x - m.position.x) * k
      m.position.y += (pose.y - m.position.y) * k
      m.position.z += (pose.z - m.position.z) * k
      m.rotation.x += (rotX - m.rotation.x) * k
      m.rotation.y += (pose.rotY + tiltY - m.rotation.y) * k
      m.rotation.z += (pose.rotZ - m.rotation.z) * k
    }

    // Camera parallax.
    const camX = this.camHome.x + (useDeviceTilt ? 0 : this.pointer.x * 0.35)
    const camY = this.camHome.y + (useDeviceTilt ? 0 : this.pointer.y * 0.12)
    const camZ = this.camHome.z
    const cd =
      Math.abs(camX - this.camera.position.x) +
      Math.abs(camY - this.camera.position.y) +
      Math.abs(camZ - this.camera.position.z)
    if (cd > 1e-3) moving = true
    this.camera.position.x += (camX - this.camera.position.x) * damp(6, dt)
    this.camera.position.y += (camY - this.camera.position.y) * damp(6, dt)
    this.camera.position.z += (camZ - this.camera.position.z) * damp(6, dt)
    this.camera.lookAt(0, 0.02, 0)
    const bookTiltX = this.mode === 'spread' ? SPREAD_LEAN + tiltX : SPREAD_LEAN
    const bookTiltY = this.mode === 'spread' ? tiltY : 0
    if (
      Math.abs(bookTiltX - this.bookGroup.rotation.x) > 1e-3 ||
      Math.abs(bookTiltY - this.bookGroup.rotation.y) > 1e-3
    ) moving = true
    this.bookGroup.rotation.x += (bookTiltX - this.bookGroup.rotation.x) * damp(8, dt)
    this.bookGroup.rotation.y += (bookTiltY - this.bookGroup.rotation.y) * damp(8, dt)

    // Page-turn deformation. 'manual' tracks the finger raw; 'run' eases to
    // completion; 'cancel' plays it back onto the stack it came from.
    if (this.turnState !== 'idle') {
      moving = true
      if (this.turnState === 'run') this.flipT = Math.min(1, this.flipT + dt / FLIP_TIME)
      else if (this.turnState === 'cancel') this.flipT = Math.max(0, this.flipT - dt / (FLIP_TIME * 0.65))
      const t = this.turnState === 'manual' ? this.flipT : easeInOut(this.flipT)
      const pos = this.turnFront.geometry.attributes.position
      for (let i = 0; i < pos.count; i++) {
        const bx = this.turnBase[i * 3]
        const by = this.turnBase[i * 3 + 1]
        const [px, py, pz] = curlPoint(bx, by, PAGE_W, t, this.flipDir)
        pos.setXYZ(i, px, py, pz)
      }
      pos.needsUpdate = true
      this.turnFront.geometry.computeVertexNormals()
      if (this.turnState === 'run' && this.flipT >= 1) {
        this.turnState = 'idle'
        this.turnGroup.visible = false
        this.setSpread(this.spread + this.flipDir * 2)
        this.events.onFlipDone?.(this.flipDir)
      } else if (this.turnState === 'cancel' && this.flipT <= 0) {
        this.turnState = 'idle'
        this.turnGroup.visible = false
        this.setSpread(this.spread) // undo the early reveal
      }
    }

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

    if (this.events.onFanAnchors) {
      const r = this.canvas.getBoundingClientRect()
      const list: { id: string; x: number; y: number }[] = []
      if (this.mode === 'fan') {
        const v = new THREE.Vector3()
        for (const entry of this.fanPages) {
          v.set(0, -PAGE_H * 0.56, 0)
          entry.mesh.localToWorld(v)
          v.project(this.camera)
          if (v.z >= 1) continue
          const x = ((v.x + 1) / 2) * r.width
          if (x < -40 || x > r.width + 40) continue
          list.push({ id: entry.id, x, y: ((1 - v.y) / 2) * r.height })
        }
      }
      this.events.onFanAnchors(list)
    }
    return moving
  }
}
