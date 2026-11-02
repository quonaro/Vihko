import * as THREE from 'three'
import {
  createRenderer, addStudioRig, createComposer, detectQuality, FramePump,
  addComicOutline, outlineMaterial, type Quality,
} from './stage'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import {
  BOOK_W, BOOK_H, BOOK_D, TILT_YAW,
  shelfPose, hoverTilt, inHitBox, viewHalfWidth, scrollLimit,
} from './shelfLayout'
import { rubberScroll, flickVelocity, momentumStep, MOMENTUM_MIN } from './gesture'
import { coverCanvas, paintCover, type CoverInput } from './coverTexture'
import { onImageLoaded } from '../ink/ops'
import { deviceTilt, deviceTiltRotation, subscribeDeviceTilt } from './deviceTilt'

export interface ShelfJournal extends CoverInput {
  id: string
}

// Screen-space anchors (canvas px) the view uses to pin its DOM overlay —
// delete / select buttons, the page-count label and the title — onto the
// 3D books.
export interface ShelfAnchor {
  id: string
  onScreen: boolean
  hover: boolean
  del: { x: number; y: number } | null
  sel: { x: number; y: number } | null
  label: { x: number; y: number } | null
  title: { x: number; y: number } | null
  actions: { x: number; y: number } | null
}

export interface ShelfEvents {
  onPick?: (id: string) => void
  onOverlay?: (anchors: ShelfAnchor[]) => void
}

const FOV = 36
const CAM_DIST = 4.9
const ENTER_TIME = 0.62
const ENTER_STAGGER = 0.055

const damp = (rate: number, dt: number) => 1 - Math.exp(-rate * dt)
const easeOut = (t: number) => 1 - (1 - t) ** 3
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

interface BookEntry {
  id: string
  sig: string
  order: number
  group: THREE.Group
  coverMat: THREE.MeshStandardMaterial
  boardMat: THREE.MeshStandardMaterial
  fadeMats: THREE.MeshStandardMaterial[]
  outlineMat: LineMaterial
  canvas: HTMLCanvasElement | null
  ctx: CanvasRenderingContext2D | null
  tex: THREE.CanvasTexture | null
  input: ShelfJournal
  enterT: number
  tiltX: number
  tiltY: number
}

export class ShelfScene {
  private renderer: THREE.WebGLRenderer
  private post: ReturnType<typeof createComposer>
  private scene = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private raycaster = new THREE.Raycaster()
  private pointer = new THREE.Vector2(0, 0)
  private row = new THREE.Group()
  private books: BookEntry[] = []
  private hovered: BookEntry | null = null
  private selectedId: string | null = null
  private scroll = 0
  private scrollTarget = 0
  private halfW = 1
  private worldPerPx = 0.01
  private cw = 2
  private ch = 2
  private drag: { id: number; x0: number; v0: number; moved: boolean } | null = null
  private trail: { x: number; t: number }[] = []
  private vel = 0 // flick momentum, world units/s
  private clickWasDrag = false
  private v = new THREE.Vector3()
  private m1 = new THREE.Matrix4()
  private localRay = new THREE.Ray()
  private pagesGeo = new THREE.BoxGeometry(BOOK_W * 0.955, BOOK_H * 0.96, BOOK_D * 0.62)
  private boardGeo = new THREE.BoxGeometry(BOOK_W, BOOK_H, BOOK_D * 0.19)
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

  constructor(
    private canvas: HTMLCanvasElement,
    private events: ShelfEvents,
    private q: Quality = detectQuality(),
  ) {
    this.renderer = createRenderer(canvas, q)
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 50)
    this.camera.position.set(0, 0.12, CAM_DIST)
    addStudioRig(this.renderer, this.scene, -BOOK_H / 2 - 0.32, q)
    this.post = createComposer(this.renderer, this.scene, this.camera, q)
    this.scene.add(this.row)

    this.unsubImages = onImageLoaded(() => this.refreshCovers())
    this.unsubDeviceTilt = subscribeDeviceTilt(() => this.pump.wake())

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

  // Low tier drops clearcoat (an extra BRDF lobe per pixel) — standard
  // materials carry everything else these books need.
  private mat(params: THREE.MeshPhysicalMaterialParameters) {
    if (this.q === 'low') {
      const p = { ...params }
      delete p.clearcoat
      delete p.clearcoatRoughness
      return new THREE.MeshStandardMaterial(p)
    }
    return new THREE.MeshPhysicalMaterial(params)
  }

  // A closed journal: paper block between two cover boards — the board
  // edge is what sells "real book".
  private makeBook(j: ShelfJournal, sig: string): BookEntry {
    const group = new THREE.Group()
    const coverC = new THREE.Color(j.coverImg ? '#33333a' : j.color)
    const paper = this.mat({
      color: 0xf2ecdd, roughness: 0.92, envMapIntensity: 0.3,
    })
    const board = this.mat({
      color: coverC, roughness: 0.55, clearcoat: 0.4,
      clearcoatRoughness: 0.5, envMapIntensity: 0.5,
    })
    const cnv = coverCanvas(j)
    const ctx = cnv?.getContext('2d') ?? null
    let tex: THREE.CanvasTexture | null = null
    if (cnv) {
      tex = new THREE.CanvasTexture(cnv)
      tex.colorSpace = THREE.SRGBColorSpace
      tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy())
    }
    const face = this.mat({
      color: tex ? 0xffffff : coverC,
      roughness: 0.58, clearcoat: 0.35, clearcoatRoughness: 0.55,
      envMapIntensity: 0.55,
    })
    if (tex) face.map = tex

    const bz = BOOK_D / 2 - (BOOK_D * 0.19) / 2
    const pages = new THREE.Mesh(this.pagesGeo, paper)
    pages.position.set(BOOK_W * 0.02, 0, 0)
    const front = new THREE.Mesh(this.boardGeo, [board, board, board, board, face, board])
    front.position.z = bz
    const back = new THREE.Mesh(this.boardGeo, board)
    back.position.z = -bz
    const outlineMat = outlineMaterial()
    outlineMat.resolution.set(this.cw, this.ch)
    addComicOutline(pages, outlineMat)
    addComicOutline(front, outlineMat)
    addComicOutline(back, outlineMat)
    for (const m of [pages, front, back]) {
      m.castShadow = true
      m.receiveShadow = true
      group.add(m)
    }
    this.row.add(group)

    const e: BookEntry = {
      id: j.id, sig, order: 0, group,
      coverMat: face, boardMat: board,
      fadeMats: [paper, board, face], outlineMat,
      canvas: cnv, ctx, tex, input: j,
      enterT: 0, tiltX: 0, tiltY: 0,
    }
    return e
  }

  private disposeBook(e: BookEntry) {
    this.row.remove(e.group)
    e.group.traverse((o) => {
      if (o instanceof LineSegments2) o.geometry.dispose()
    })
    e.tex?.dispose()
    for (const m of e.fadeMats) m.dispose()
    e.outlineMat.dispose()
    if (this.hovered === e) this.hovered = null
  }

  private static sig(j: ShelfJournal) {
    return `${j.color}|${j.coverImg ? j.coverImg.slice(-24) : ''}`
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
      if (e && e.sig !== sig) {
        this.disposeBook(e)
        e = undefined
      }
      if (e) pool.delete(j.id)
      else {
        e = this.makeBook(j, sig)
        e.enterT = -i * ENTER_STAGGER
      }
      e.order = i
      next.push(e)
    })
    for (const e of pool.values()) this.disposeBook(e)
    this.books = next
    this.scrollTarget = this.clampScroll(this.scrollTarget)
    this.setSelected(this.selectedId)
    if (this.hovered && !next.includes(this.hovered)) this.hovered = null
  }

  setSelected(id: string | null) {
    this.pump.wake()
    this.selectedId = id
    for (const e of this.books) {
      const on = e.id === id
      e.coverMat.emissive.setHex(on ? 0x5a3f14 : 0x000000)
      e.boardMat.emissive.setHex(on ? 0x4a3512 : 0x000000)
    }
  }

  // Bounding rect of a book's front face in canvas px (morph source).
  screenRect(id: string): { left: number; top: number; width: number; height: number } | null {
    const e = this.books.find((b) => b.id === id)
    if (!e) return null
    e.group.updateWorldMatrix(true, false)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const [lx, ly] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const p = this.project(e, (lx * BOOK_W) / 2, (ly * BOOK_H) / 2, BOOK_D / 2)
      if (!p) return null
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y)
    }
    return { left: minX, top: minY, width: maxX - minX, height: maxY - minY }
  }

  dispose() {
    this.pump.stop()
    this.ro.disconnect()
    this.unsubImages()
    this.unsubDeviceTilt()
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
        if (Array.isArray(m)) m.forEach((x) => x.dispose())
        else m.dispose()
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

  private clampScroll(v: number) {
    const l = scrollLimit(this.halfW, this.books.length)
    return clamp(v, -l, l)
  }

  private onPointerDown = (e: PointerEvent) => {
    this.pump.wake()
    if (this.drag) return // a second finger must not rebase the ongoing pan
    this.drag = { id: e.pointerId, x0: e.clientX, v0: this.scrollTarget, moved: false }
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
        const limit = scrollLimit(this.halfW, this.books.length)
        this.scrollTarget = rubberScroll(this.drag.v0 - dx * this.worldPerPx, limit)
        this.hovered = null
        this.canvas.style.cursor = 'grabbing'
        return
      }
    }
    this.pick(x, y)
  }

  private onPointerUp = (e: PointerEvent) => this.endDrag(e, true)
  private onPointerCancel = (e: PointerEvent) => this.endDrag(e, false)

  private endDrag(e: PointerEvent, flick: boolean) {
    this.pump.wake()
    if (this.drag && e.pointerId !== this.drag.id) return // other finger lifted
    if (this.drag && this.drag.moved && flick) {
      this.vel = -flickVelocity(this.trail, e.timeStamp) * this.worldPerPx
      this.scrollTarget = this.clampScroll(this.scrollTarget)
    }
    this.drag = null
    this.trail = []
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId)
    this.canvas.style.cursor = ''
  }

  private onPointerLeave = () => {
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
    for (const b of this.books) {
      if (best && b === best.e) {
        b.tiltX = clamp(best.px / (BOOK_W / 2), -1, 1)
        b.tiltY = clamp(best.py / (BOOK_H / 2), -1, 1)
      } else {
        b.tiltX = 0
        b.tiltY = 0
      }
    }
  }

  // --- per-frame ----------------------------------------------------------

  private resize() {
    const w = this.canvas.clientWidth || 2
    const h = this.canvas.clientHeight || 2
    this.cw = w
    this.ch = h
    this.renderer.setSize(w, h, false)
    this.post.setSize(w, h)
    for (const e of this.books) e.outlineMat.resolution.set(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.halfW = viewHalfWidth(FOV, CAM_DIST, w / h)
    this.worldPerPx = (2 * this.halfW) / w
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
      const actions = this.project(e, 0, -BOOK_H / 2 - 0.05, 0)
      out.push({
        id: e.id,
        onScreen: !!label && label.x > -this.cw * 0.25 && label.x < this.cw * 1.25,
        hover: e === this.hovered,
        del: this.project(e, BOOK_W / 2, BOOK_H / 2, BOOK_D / 2),
        sel: this.project(e, BOOK_W / 2 - 0.16, -BOOK_H / 2 + 0.16, BOOK_D / 2),
        label,
        title,
        actions,
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
      let tz = base.z
      let trx = base.rotX
      let try_ = base.rotY
      let ts = base.scale
      if (deviceTilt.active) {
        const t = deviceTiltRotation(deviceTilt.x, deviceTilt.y, TILT_YAW)
        try_ += t.rotY
        trx += t.rotX
      } else if (e === this.hovered) {
        const t = hoverTilt(e.tiltX, e.tiltY)
        try_ = t.rotY
        trx = t.rotX
      }
      // Entrance mirrors the DOM rise-in: staggered, from below, fading in.
      const en = easeOut(Math.max(0, e.enterT))
      ty += (en - 1) * 0.5
      ts *= 0.94 + 0.06 * en
      const g = e.group
      const trz = (1 - en) * -0.05
      const d =
        Math.abs(base.x - g.position.x) + Math.abs(ty - g.position.y) +
        Math.abs(tz - g.position.z) + Math.abs(trx - g.rotation.x) +
        Math.abs(try_ - g.rotation.y) + Math.abs(trz - g.rotation.z) +
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
        m.opacity = en
        m.transparent = en < 1
      }
      e.outlineMat.opacity = en * 0.82
    }

    if (Math.abs(this.vel) > MOMENTUM_MIN && !this.drag) {
      moving = true
      const s = momentumStep(this.scrollTarget, this.vel, scrollLimit(this.halfW, n), dt)
      this.scrollTarget = s.pos
      this.vel = s.vel
    } else if (this.drag) {
      this.vel = 0
    }
    this.scroll += (this.scrollTarget - this.scroll) * damp(9, dt)
    if (Math.abs(this.scrollTarget - this.scroll) > 1e-4) moving = true
    this.row.position.x = -this.scroll

    // Subtle camera parallax, same idea as the journal scene.
    const cx = deviceTilt.active ? 0 : this.pointer.x * 0.22
    const cy = 0.12 + (deviceTilt.active ? 0 : this.pointer.y) * 0.09
    const cz = CAM_DIST
    const cd =
      Math.abs(cx - this.camera.position.x) +
      Math.abs(cy - this.camera.position.y) +
      Math.abs(cz - this.camera.position.z)
    if (cd > 1e-3) moving = true
    this.camera.position.x += (cx - this.camera.position.x) * damp(6, dt)
    this.camera.position.y += (cy - this.camera.position.y) * damp(6, dt)
    this.camera.position.z += (cz - this.camera.position.z) * damp(6, dt)
    this.camera.lookAt(0, 0.02, 0)

    this.emitAnchors()
    return moving
  }
}
