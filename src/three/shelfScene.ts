import * as THREE from 'three'
import {
  createRenderer,
  addStudioRig,
  createComposer,
  detectQuality,
  FramePump,
  type Quality,
} from './stage'
import {
  BOOK_W,
  BOOK_H,
  BOOK_D,
  SHELF_STEP,
  TILT_LIFT,
  BOARD_T,
  PAGES_D,
  pagesOutline,
  boardOutline,
  shelfEntrance,
  shelfPose,
  inHitBox,
  scrollLimit,
} from './shelfLayout'
import {
  rubberScroll,
  flickVelocity,
  momentumStep,
  MOMENTUM_MIN,
  pinchZoom,
  panLimit,
} from './gesture'
import { coverCanvas, paintCover, type CoverInput } from './coverTexture'
import { onImageLoaded } from '../ink/ops'

export interface ShelfJournal extends CoverInput {
  id: string
}

// Screen-space anchors (canvas px) the view uses to pin its DOM overlay —
// page-count label and title onto the 3D books.
export interface ShelfAnchor {
  id: string
  onScreen: boolean
  label: { x: number; y: number } | null
  title: { x: number; y: number } | null
}

export interface ShelfEvents {
  onPick?: (id: string) => void
  onLongPress?: (id: string) => void
  onOverlay?: (anchors: ShelfAnchor[]) => void
}

const FOV = 36
// Top-down table view: the camera sits almost straight above the row —
// a small z offset keeps the boards' thickness readable. Its distance is
// picked per-viewport in resize() so a fixed number of books fits across.
const CAM_Y = 4.85
const CAM_Z = 0.6
const ENTER_TIME = 0.38
const ENTER_STAGGER = 0.04

const damp = (rate: number, dt: number) => 1 - Math.exp(-rate * dt)
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

// Paper block and cover boards are extruded from the rounded outlines —
// a plain box leaves corners sharp while the journal inside rounds them
// (sheetPoint). Arc steps stay under the EdgesGeometry threshold, so the
// comic outline still traces just the two rounded cap loops, no wall
// stripes.
function extrudeOutline(points: [number, number][], depth: number): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)))
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false })
  g.translate(0, 0, -depth / 2)
  return g
}

function pagesGeometry(): THREE.BufferGeometry {
  return extrudeOutline(pagesOutline(), PAGES_D)
}

// ExtrudeGeometry caps carry material index 0 and the side walls index 1,
// so the front board maps the cover texture across both lids (the hidden
// inner lid never shows past the page block).
function boardGeometry(): THREE.BufferGeometry {
  const g = extrudeOutline(boardOutline(), BOARD_T)
  // Cap UVs arrive in shape coordinates — normalise to 0..1 so the cover
  // texture spans the face.
  const uv = g.attributes.uv as THREE.BufferAttribute
  const pos = g.attributes.position
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, pos.getX(i) / BOOK_W + 0.5, pos.getY(i) / BOOK_H + 0.5)
  }
  return g
}

interface BookEntry {
  id: string
  sig: string
  order: number
  group: THREE.Group
  fadeMats: THREE.Material[]
  canvas: HTMLCanvasElement | null
  ctx: CanvasRenderingContext2D | null
  tex: THREE.CanvasTexture | null
  input: ShelfJournal
  enterT: number
}

export class ShelfScene {
  private renderer: THREE.WebGLRenderer
  private post: ReturnType<typeof createComposer>
  private scene = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private raycaster = new THREE.Raycaster()
  private row = new THREE.Group()
  private books: BookEntry[] = []
  private hovered: BookEntry | null = null
  private scroll = 0
  private scrollTarget = 0
  private halfW = 1
  private camDist = 1 // fit distance along camDir, picked per viewport
  private camDir = new THREE.Vector3(0, CAM_Y, CAM_Z).normalize()
  private worldPerPx = 0.01
  private cw = 2
  private ch = 2
  private drag: {
    id: number
    x0: number
    y0: number
    v0: number
    pan0: number
    moved: boolean
  } | null = null
  private trail: { x: number; t: number }[] = []
  private vel = 0 // flick momentum, world units/s
  private clickWasDrag = false
  private holdTimer: ReturnType<typeof setTimeout> | undefined
  private hold: { id: number; x: number; y: number; bookId: string } | null = null
  // Pinch zoom: 1 = the fit distance; the camera dollies along camDir by
  // 1/zoom. Horizontal travel stays on the row scroll (the pan limit is
  // far smaller than a long shelf), so the camera only pans vertically —
  // `panY` is a view-plane offset (world units, screen-up) applied to
  // camera and look target together. Touches are tracked separately from
  // `drag` so a second finger can turn a scroll into a pinch mid-gesture.
  private zoom = 1
  private panY = 0
  private touches = new Map<number, { x: number; y: number }>()
  private pinch: { d0: number; zoom0: number; mx: number; my: number } | null = null
  private camUp = new THREE.Vector3()
  private lookPos = new THREE.Vector3()
  private camTarget = new THREE.Vector3()
  private lookTarget = new THREE.Vector3()
  private v = new THREE.Vector3()
  private m1 = new THREE.Matrix4()
  private localRay = new THREE.Ray()
  private pagesGeo = pagesGeometry()
  private boardGeo = boardGeometry()
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

  constructor(
    private canvas: HTMLCanvasElement,
    private events: ShelfEvents,
    q: Quality = detectQuality(),
  ) {
    this.renderer = createRenderer(canvas, q)
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 50)
    this.camera.position.set(0, CAM_Y, CAM_Z)
    this.camera.lookAt(0, 0, 0)
    // View-plane up in world space: the camera looks almost straight
    // down, so screen-up maps mostly to world -z. Screen-right is +x —
    // the row scroll already owns that axis.
    const dir = this.camDir.clone().negate()
    const right = new THREE.Vector3().crossVectors(dir, this.camera.up).normalize()
    this.camUp.crossVectors(right, dir).normalize()
    addStudioRig(this.renderer, this.scene, -0.015, q)
    this.post = createComposer(this.renderer, this.scene, this.camera, q)
    this.scene.add(this.row)

    this.unsubImages = onImageLoaded(() => this.refreshCovers())

    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointermove', this.onPointerMove)
    canvas.addEventListener('pointerup', this.onPointerUp)
    canvas.addEventListener('pointercancel', this.onPointerCancel)
    canvas.addEventListener('pointerleave', this.onPointerLeave)
    canvas.addEventListener('click', this.onClick)
    canvas.addEventListener('wheel', this.onWheel, { passive: false })
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(canvas)
    this.resize()
  }

  // --- construction -------------------------------------------------------

  // A closed journal: paper block between two cover boards — the board
  // edge is what sells "real book". All materials stay matte — Paper's
  // flat look has no lacquer sheen on covers.
  private makeBook(j: ShelfJournal, sig: string): BookEntry {
    const group = new THREE.Group()
    // ZYX: rotX lays the book flat (applied first), rotY spins it in the
    // table plane, rotZ dips a side edge — matches shelfPose/hoverTilt.
    group.rotation.order = 'ZYX'
    const coverC = new THREE.Color(j.coverImg ? '#33333a' : j.color)
    const paper = new THREE.MeshStandardMaterial({
      color: 0xf2ecdd,
      roughness: 0.95,
      envMapIntensity: 0.25,
    })
    const board = new THREE.MeshStandardMaterial({
      color: coverC,
      roughness: 0.9,
      envMapIntensity: 0.3,
    })
    const cnv = coverCanvas(j)
    const ctx = cnv?.getContext('2d') ?? null
    let tex: THREE.CanvasTexture | null = null
    if (cnv) {
      tex = new THREE.CanvasTexture(cnv)
      tex.colorSpace = THREE.SRGBColorSpace
      tex.anisotropy = Math.min(16, this.renderer.capabilities.getMaxAnisotropy())
    }
    // The cover face stays unlit: under the studio rig a lit material
    // washes the artwork out, so the printed texture is shown as-is.
    const face = new THREE.MeshBasicMaterial({
      color: tex ? 0xffffff : coverC,
    })
    face.toneMapped = false
    if (tex) face.map = tex

    const bz = BOOK_D / 2 - BOARD_T / 2
    const pages = new THREE.Mesh(this.pagesGeo, paper)
    pages.position.set(BOOK_W * 0.02, 0, 0)
    const front = new THREE.Mesh(this.boardGeo, [face, board])
    front.position.z = bz
    const back = new THREE.Mesh(this.boardGeo, board)
    back.position.z = -bz
    for (const m of [pages, front, back]) {
      m.castShadow = true
      m.receiveShadow = true
      group.add(m)
    }
    this.row.add(group)

    const e: BookEntry = {
      id: j.id,
      sig,
      order: 0,
      group,
      fadeMats: [paper, board, face],
      canvas: cnv,
      ctx,
      tex,
      input: j,
      enterT: 0,
    }
    return e
  }

  private disposeBook(e: BookEntry) {
    this.row.remove(e.group)
    e.tex?.dispose()
    for (const m of e.fadeMats) m.dispose()
    if (this.hovered === e) this.hovered = null
  }

  private static sig(j: ShelfJournal) {
    return `${j.color}|${j.coverImg ? j.coverImg.slice(-24) : ''}|${j.coverTexture ?? 'paper'}`
  }

  // --- public API ---------------------------------------------------------

  // Reconcile books with the journal list; entries whose cover signature is
  // unchanged keep their textures (search filtering doesn't repaint).
  setJournals(list: ShelfJournal[]) {
    this.pump.wake()
    const pool = new Map(this.books.map((b) => [b.id, b]))
    const next: BookEntry[] = []
    list.forEach((j, i) => {
      const sig = ShelfScene.sig(j)
      let e = pool.get(j.id)
      let created = false
      if (e) {
        pool.delete(j.id)
        if (e.sig !== sig) {
          this.disposeBook(e)
          e = this.makeBook(j, sig)
          created = true
          // A cover refresh is not a new journal; don't replay the entrance.
          e.enterT = 1
        }
      } else {
        e = this.makeBook(j, sig)
        created = true
        e.enterT = -i * ENTER_STAGGER
      }
      e.order = i
      if (created) {
        const pose = shelfPose(i, list.length)
        const entrance = shelfEntrance(e.enterT)
        e.group.position.set(pose.x, pose.y + entrance.lift, pose.z)
        e.group.rotation.set(pose.rotX, pose.rotY, pose.rotZ)
        e.group.scale.setScalar(pose.scale * entrance.scale)
      }
      next.push(e)
    })
    for (const e of pool.values()) this.disposeBook(e)
    this.books = next
    this.scrollTarget = this.clampScroll(this.scrollTarget)
    if (this.hovered && !next.includes(this.hovered)) this.hovered = null
  }

  // Bounding rect of a book's front face in canvas px (morph source).
  screenRect(id: string): { left: number; top: number; width: number; height: number } | null {
    const e = this.books.find((b) => b.id === id)
    if (!e) return null
    e.group.updateWorldMatrix(true, false)
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity
    for (const [lx, ly] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      const p = this.project(e, (lx * BOOK_W) / 2, (ly * BOOK_H) / 2, BOOK_D / 2)
      if (!p) return null
      minX = Math.min(minX, p.x)
      maxX = Math.max(maxX, p.x)
      minY = Math.min(minY, p.y)
      maxY = Math.max(maxY, p.y)
    }
    return { left: minX, top: minY, width: maxX - minX, height: maxY - minY }
  }

  dispose() {
    this.pump.stop()
    this.cancelHold()
    this.ro.disconnect()
    this.unsubImages()
    const c = this.canvas
    c.removeEventListener('pointerdown', this.onPointerDown)
    c.removeEventListener('pointermove', this.onPointerMove)
    c.removeEventListener('pointerup', this.onPointerUp)
    c.removeEventListener('pointercancel', this.onPointerCancel)
    c.removeEventListener('pointerleave', this.onPointerLeave)
    c.removeEventListener('click', this.onClick)
    c.removeEventListener('wheel', this.onWheel)
    for (const e of this.books) this.disposeBook(e)
    this.books = []
    this.pagesGeo.dispose()
    this.boardGeo.dispose()
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
    this.post.dispose()
    this.renderer.dispose()
  }

  start() {
    this.last = performance.now()
    this.pump.start()
  }

  // --- input ---------------------------------------------------------------

  // Zoom shrinks the visible world width, so the row ends get more
  // scroll travel and every book can still be centered while zoomed in.
  private get scrollLim() {
    return scrollLimit(this.halfW / this.zoom, this.books.length)
  }

  private clampScroll(v: number) {
    return clamp(v, -this.scrollLim, this.scrollLim)
  }

  // px → world at the zoomed distance — drag gain and pinch pan both
  // use it, so it scales with 1/zoom.
  private updateWorldPerPx() {
    this.worldPerPx = (2 * this.halfW) / (this.cw * this.zoom)
  }

  // Vertical pan is clamped by the zoom-dependent limit — at fit zoom it
  // is zero, so the shelf always recenters vertically on pinch-out.
  private setPanY(y: number) {
    this.panY = clamp(y, -panLimit(this.zoom), panLimit(this.zoom))
  }

  private onPointerDown = (e: PointerEvent) => {
    this.pump.wake()
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY })
    this.canvas.setPointerCapture(e.pointerId)
    if (this.touches.size === 2) {
      this.cancelHold()
      // A second finger converts any one-finger scroll into a pinch.
      this.drag = null
      this.trail = []
      this.canvas.style.cursor = ''
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
    if (this.touches.size > 2 || this.pinch || this.drag) return
    this.drag = {
      id: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      v0: this.scrollTarget,
      pan0: this.panY,
      moved: false,
    }
    this.trail = [{ x: e.clientX, t: e.timeStamp }]
    this.vel = 0
    this.clickWasDrag = false
    const rect = this.canvas.getBoundingClientRect()
    this.pick(e.clientX - rect.left, e.clientY - rect.top)
    if (this.hovered) {
      this.hold = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        bookId: this.hovered.id,
      }
      this.holdTimer = setTimeout(() => {
        if (!this.hold || this.drag?.moved) return
        this.clickWasDrag = true
        this.events.onLongPress?.(this.hold.bookId)
      }, 550)
    }
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
      // The midpoint's travel moves the view — horizontally it scrolls
      // the row, vertically it pans the camera. Incremental, so it keeps
      // tracking the fingers while the px→world gain changes.
      const mx = (a.x + b.x) / 2
      const my = (a.y + b.y) / 2
      this.scrollTarget = this.clampScroll(
        this.scrollTarget - (mx - this.pinch.mx) * this.worldPerPx,
      )
      this.setPanY(this.panY + (my - this.pinch.my) * this.worldPerPx)
      this.pinch.mx = mx
      this.pinch.my = my
      return
    }
    const r = this.canvas.getBoundingClientRect()
    const x = e.clientX - r.left
    const y = e.clientY - r.top
    if (this.drag && e.pointerId === this.drag.id && e.buttons) {
      if (this.hold && Math.hypot(e.clientX - this.hold.x, e.clientY - this.hold.y) > 10) {
        this.cancelHold()
      }
      this.trail.push({ x: e.clientX, t: e.timeStamp })
      if (this.trail.length > 16) this.trail.shift()
      const dx = e.clientX - this.drag.x0
      const dy = e.clientY - this.drag.y0
      // While zoomed, a drag also pans vertically — horizontal motion
      // keeps scrolling the row at any zoom.
      const panning = this.zoom > 1.05
      if (panning ? Math.hypot(dx, dy) > 6 : Math.abs(dx) > 6) this.drag.moved = true
      if (this.drag.moved) {
        this.clickWasDrag = true
        this.hovered = null
        this.canvas.style.cursor = 'grabbing'
        this.scrollTarget = rubberScroll(this.drag.v0 - dx * this.worldPerPx, this.scrollLim)
        if (panning) this.setPanY(this.drag.pan0 + dy * this.worldPerPx)
        return
      }
    }
    this.pick(x, y)
  }

  private onPointerUp = (e: PointerEvent) => this.endDrag(e, true)
  private onPointerCancel = (e: PointerEvent) => this.endDrag(e, false)

  private endDrag(e: PointerEvent, flick: boolean) {
    this.pump.wake()
    this.cancelHold()
    this.touches.delete(e.pointerId)
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId)
    if (this.pinch) {
      // Rebase on the remaining pair — or hand the last finger a drag,
      // so the gesture continues as scroll/pan instead of ending.
      this.pinch = null
      if (this.touches.size >= 2) {
        const [a, b] = [...this.touches.values()]
        this.pinch = {
          d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
          zoom0: this.zoom,
          mx: (a.x + b.x) / 2,
          my: (a.y + b.y) / 2,
        }
      } else if (this.touches.size === 1) {
        const [id, t] = [...this.touches.entries()][0]
        this.drag = {
          id,
          x0: t.x,
          y0: t.y,
          v0: this.scrollTarget,
          pan0: this.panY,
          moved: true,
        }
        this.trail = [{ x: t.x, t: e.timeStamp }]
      }
    }
    if (this.drag && e.pointerId !== this.drag.id) return // other finger lifted
    if (this.drag?.moved && flick) {
      this.vel = -flickVelocity(this.trail, e.timeStamp) * this.worldPerPx
      this.scrollTarget = this.clampScroll(this.scrollTarget)
    }
    this.drag = null
    this.trail = []
    this.canvas.style.cursor = ''
  }

  private onPointerLeave = () => {
    this.cancelHold()
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
    if (this.hovered) this.events.onPick?.(this.hovered.id)
  }

  private cancelHold() {
    if (this.holdTimer !== undefined) clearTimeout(this.holdTimer)
    this.holdTimer = undefined
    this.hold = null
  }

  private onWheel = (e: WheelEvent) => {
    this.pump.wake()
    e.preventDefault()
    this.vel = 0
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
    this.scrollTarget = this.clampScroll(this.scrollTarget + d * this.worldPerPx * 1.4)
  }

  // Intersect the pointer ray with each book's front-face plane in local
  // space — gives the tilt position directly and a pick region (inHitBox)
  // slightly larger than the cover.
  private pick(x: number, y: number) {
    const r = this.canvas.getBoundingClientRect()
    this.raycaster.setFromCamera(
      new THREE.Vector2((x / r.width) * 2 - 1, -(y / r.height) * 2 + 1),
      this.camera,
    )
    let best: { e: BookEntry; t: number; px: number; py: number } | null = null
    for (const e of this.books) {
      e.group.updateWorldMatrix(true, false)
      this.localRay
        .copy(this.raycaster.ray)
        .applyMatrix4(this.m1.copy(e.group.matrixWorld).invert())
      const rd = this.localRay.direction
      if (Math.abs(rd.z) < 1e-6) continue
      const t = (BOOK_D / 2 - this.localRay.origin.z) / rd.z
      if (t <= 0) continue
      const px = this.localRay.origin.x + rd.x * t
      const py = this.localRay.origin.y + rd.y * t
      if (!inHitBox(px, py)) continue
      if (!best || t < best.t) best = { e, t, px, py }
    }
    this.hovered = best?.e ?? null
    this.canvas.style.cursor = best ? 'pointer' : ''
  }

  // --- per-frame ----------------------------------------------------------

  private resize() {
    const w = this.canvas.clientWidth || 2
    const h = this.canvas.clientHeight || 2
    this.cw = w
    this.ch = h
    this.renderer.setSize(w, h, false)
    this.post.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    // Fit ~5 books across on wide screens, a single one on portrait
    // phones: pick the camera distance that makes exactly that many
    // shelf steps span the viewport.
    const aspect = w / h
    const books = aspect < 1 ? 1 : Math.min(5, Math.max(2, Math.round(aspect * 3)))
    const halfW = (books * SHELF_STEP) / 2 + 0.15
    this.camDist = halfW / (Math.tan((FOV * Math.PI) / 360) * aspect)
    this.halfW = halfW
    this.updateWorldPerPx()
    this.camera.position
      .copy(this.camDir)
      .multiplyScalar(this.camDist / this.zoom)
      .addScaledVector(this.camUp, this.panY)
    this.lookPos.copy(this.camUp).multiplyScalar(this.panY)
    this.camera.lookAt(this.lookPos)
    this.scrollTarget = this.clampScroll(this.scrollTarget)
    this.pump.wake()
  }

  private project(e: BookEntry, lx: number, ly: number, lz: number) {
    this.v.set(lx, ly, lz)
    e.group.localToWorld(this.v)
    this.v.project(this.camera)
    if (this.v.z >= 1) return null
    return { x: ((this.v.x + 1) / 2) * this.cw, y: ((1 - this.v.y) / 2) * this.ch }
  }

  private refreshCovers() {
    this.pump.wake()
    for (const e of this.books) {
      if (!e.input.coverImg || !e.canvas || !e.ctx || !e.tex) continue
      paintCover(e.canvas, e.ctx, e.input)
      e.tex.needsUpdate = true
    }
  }

  private emitAnchors() {
    const out: ShelfAnchor[] = []
    for (const e of this.books) {
      e.group.updateWorldMatrix(true, false)
      const label = this.project(e, 0, BOOK_H / 2 + 0.18, 0)
      const title = this.project(e, 0, -BOOK_H / 2 - 0.04, 0)
      out.push({
        id: e.id,
        onScreen: !!label && label.x > -this.cw * 0.25 && label.x < this.cw * 1.25,
        label,
        title,
      })
    }
    this.events.onOverlay?.(out)
  }

  // Same contract as JournalScene.tick: returns true while anything is
  // still moving, letting the FramePump idle to zero GPU when it's not.
  private tick(dt: number): boolean {
    let moving = false
    const n = this.books.length
    const k = damp(12, dt)
    for (const e of this.books) {
      e.enterT = Math.min(1, e.enterT + dt / ENTER_TIME)
      if (e.enterT < 1) moving = true
      const base = shelfPose(e.order, n)
      let ty = base.y
      const tz = base.z
      const trx = base.rotX
      const try_ = base.rotY
      const trz = base.rotZ
      let ts = base.scale
      if (e === this.hovered) {
        ty += TILT_LIFT
      }
      // New books fade in and settle subtly; keep their cover orientation fixed.
      const entrance = shelfEntrance(e.enterT)
      ty += entrance.lift
      ts *= entrance.scale
      const g = e.group
      const d =
        Math.abs(base.x - g.position.x) +
        Math.abs(ty - g.position.y) +
        Math.abs(tz - g.position.z) +
        Math.abs(trx - g.rotation.x) +
        Math.abs(try_ - g.rotation.y) +
        Math.abs(trz - g.rotation.z) +
        Math.abs(ts - g.scale.x)
      if (d > 1e-3) moving = true
      g.position.x += (base.x - g.position.x) * k
      g.position.y += (ty - g.position.y) * k
      g.position.z += (tz - g.position.z) * k
      g.rotation.x += (trx - g.rotation.x) * k
      g.rotation.y += (try_ - g.rotation.y) * k
      g.rotation.z += (trz - g.rotation.z) * k
      g.scale.setScalar(g.scale.x + (ts - g.scale.x) * k)
      for (const m of e.fadeMats) {
        m.opacity = entrance.opacity
        m.transparent = entrance.opacity < 1
      }
    }

    if (Math.abs(this.vel) > MOMENTUM_MIN && !this.drag) {
      moving = true
      const s = momentumStep(this.scrollTarget, this.vel, this.scrollLim, dt)
      this.scrollTarget = s.pos
      this.vel = s.vel
    } else if (this.drag) {
      this.vel = 0
    }
    this.scroll += (this.scrollTarget - this.scroll) * damp(9, dt)
    if (Math.abs(this.scrollTarget - this.scroll) > 1e-4) moving = true
    this.row.position.x = -this.scroll

    // Camera: pinch zoom dollies along the look axis, vertical pan
    // slides camera and look target together so the view shifts in
    // parallel instead of tilting. Damped — tighter mid-pinch.
    this.camTarget
      .copy(this.camDir)
      .multiplyScalar(this.camDist / this.zoom)
      .addScaledVector(this.camUp, this.panY)
    this.lookTarget.copy(this.camUp).multiplyScalar(this.panY)
    const ck = damp(this.pinch ? 16 : 6, dt)
    const cd =
      Math.abs(this.camTarget.x - this.camera.position.x) +
      Math.abs(this.camTarget.y - this.camera.position.y) +
      Math.abs(this.camTarget.z - this.camera.position.z)
    if (cd > 1e-3) moving = true
    this.camera.position.x += (this.camTarget.x - this.camera.position.x) * ck
    this.camera.position.y += (this.camTarget.y - this.camera.position.y) * ck
    this.camera.position.z += (this.camTarget.z - this.camera.position.z) * ck
    this.lookPos.lerp(this.lookTarget, ck)
    if (this.lookPos.distanceToSquared(this.lookTarget) > 1e-6) moving = true
    this.camera.lookAt(this.lookPos)

    this.emitAnchors()
    return moving
  }
}
