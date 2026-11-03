import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'

// Shared "studio" setup for the 3D views: a filmic renderer plus a
// three-point lighting rig, IBL env map and a shadow-catching floor, so
// the journal spread and the shelf share the same look.

export type Quality = 'low' | 'high'

// Ink border width in CSS px. WebGL ignores `linewidth` on plain lines —
// they always rasterize 1 device px — so the outline uses the fat-line
// shader (instanced screen-space quads) for real, zoom-independent
// thickness. Every LineMaterial must have its `resolution` uniform kept
// in sync with the canvas CSS size (see the scenes' resize()).
export const OUTLINE_PX = 1.8

export function outlineMaterial(): LineMaterial {
  return new LineMaterial({
    color: 0x29231f,
    linewidth: OUTLINE_PX,
    transparent: true,
    opacity: 0.82,
    depthWrite: false,
    toneMapped: false,
    // The quad is centred on the edge, half sunk into the paper — at
    // grazing angles it z-fights the surface into a dashed ladder. A small
    // depth bias lets the ink win over its own sheet but stay behind
    // geometry that is genuinely in front.
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  })
}

export function addComicOutline(
  mesh: THREE.Mesh,
  material = outlineMaterial(),
) {
  const edges = new THREE.EdgesGeometry(mesh.geometry, 24)
  const geometry = new LineSegmentsGeometry()
  geometry.setPositions(edges.attributes.position.array as Float32Array)
  edges.dispose()
  const outline = new LineSegments2(geometry, material)
  outline.renderOrder = 2
  outline.raycast = () => {}
  mesh.add(outline)
  return outline
}

// Ordered vertex-index ring around a PlaneGeometry-style grid (row-major,
// segX×segY cells) — the closed perimeter, each vertex once. A LineLoop
// indexed by this ring and sharing the mesh's live position buffer draws
// an outline that follows per-frame vertex deformation; EdgesGeometry
// would bake a static copy that stays behind on the rest pose.
export function gridEdgeLoop(segX: number, segY: number): number[] {
  const at = (x: number, y: number) => y * (segX + 1) + x
  const idx: number[] = []
  for (let x = 0; x < segX; x++) idx.push(at(x, 0))
  for (let y = 0; y < segY; y++) idx.push(at(segX, y))
  for (let x = segX; x > 0; x--) idx.push(at(x, segY))
  for (let y = segY; y > 0; y--) idx.push(at(0, y))
  return idx
}

// One render path for every device — a desktop shows what a phone shows:
// straight to the canvas with plain PCF shadows and a lower pixel ratio.
// The HDR MSAA composer + VSM blur stay available as 'high' via the
// localStorage override for testing: vihko:gl-quality = low|high.
export function detectQuality(): Quality {
  const forced =
    typeof localStorage !== 'undefined'
      ? localStorage.getItem('vihko:gl-quality')
      : null
  if (forced === 'low' || forced === 'high') return forced
  return 'low'
}

// Render-on-demand scheduler: wake() guarantees a frame; the loop keeps
// running only while the scene reports motion, so an idle shelf/journal
// stops burning GPU + battery entirely.
export class FramePump {
  private raf = 0
  private live = false
  // frame returns true while the scene is still animating.
  constructor(private frame: (now: number) => boolean) {}
  start() {
    this.live = true
    this.wake()
  }
  stop() {
    this.live = false
    cancelAnimationFrame(this.raf)
    this.raf = 0
  }
  wake() {
    if (!this.live || this.raf) return
    this.raf = requestAnimationFrame((now) => {
      this.raf = 0
      if (this.live && this.frame(now)) this.wake()
    })
  }
}

export function createRenderer(canvas: HTMLCanvasElement, q: Quality = detectQuality()) {
  // On the low tier this canvas is the final output — antialias here is its
  // only MSAA. On high it would just burn resolve bandwidth: the composer
  // renders into its own multisampled target and blits a fullscreen quad.
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: q === 'low', alpha: true })
  // Floor of 1.5 gives DPR-1 displays real supersampling — the worst case
  // for stair-stepping on the near-horizontal page/cover edges. Cap at 2:
  // the composer targets an MSAA×4 HalfFloat buffer, so each extra step of
  // pixel ratio multiplies framebuffer memory quadratically. The low tier
  // caps harder: mid-range GPUs are fill-rate bound and a phone panel
  // gains little past ~1.5.
  renderer.setPixelRatio(
    q === 'low'
      ? Math.min(window.devicePixelRatio || 1, 1.5)
      : Math.min(Math.max(window.devicePixelRatio, 1.5), 2),
  )
  renderer.shadowMap.enabled = true
  // VSM: the only soft-shadow path left — `shadow.radius` + `blurSamples`
  // blur the variance map edges (PCFSoft was removed in r186). The low
  // tier falls back to plain PCF: a float map plus two 2048² blur passes
  // per frame is exactly what a mid-range phone can't afford.
  renderer.shadowMap.type = q === 'low' ? THREE.PCFShadowMap : THREE.VSMShadowMap
  // Filmic rolloff keeps the paper bright without clipping to flat white.
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.05
  return renderer
}

// Post pipeline shared by both scenes: the scene renders into a
// multisampled (MSAA ×4) HDR target, OutputPass applies tone mapping +
// sRGB, and FXAA cleans up the remaining edge jaggies the MSAA misses.
// The low tier skips it entirely — tone mapping + sRGB then run in the
// material shaders as the renderer draws to the canvas directly.
export function createComposer(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  q: Quality = detectQuality(),
) {
  if (q === 'low') {
    return {
      render: () => renderer.render(scene, camera),
      setSize: () => {},
      dispose: () => {},
    }
  }
  const size = renderer.getDrawingBufferSize(new THREE.Vector2())
  const rt = new THREE.WebGLRenderTarget(size.x, size.y, {
    type: THREE.HalfFloatType,
    samples: 4,
  })
  const composer = new EffectComposer(renderer, rt)
  composer.addPass(new RenderPass(scene, camera))
  composer.addPass(new OutputPass())
  const fxaa = new ShaderPass(FXAAShader)
  composer.addPass(fxaa)

  const setSize = (w: number, h: number) => {
    composer.setSize(w, h)
    const pr = renderer.getPixelRatio()
    fxaa.material.uniforms.resolution.value.set(1 / (w * pr), 1 / (h * pr))
  }
  return {
    render: () => composer.render(),
    setSize,
    dispose: () => composer.dispose(),
  }
}

export function addStudioRig(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  groundY: number,
  q: Quality = detectQuality(),
) {
  // Image-based lighting: a small studio rig baked into an env map lifts
  // the matte surfaces evenly — Paper's flat look is mostly ambient.
  const pmrem = new THREE.PMREMGenerator(renderer)
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
  scene.environmentIntensity = 0.38
  pmrem.dispose()

  // Soft flat rig: strong ambient carries the matte covers while a low
  // key from the back-left draws the long gentle shadow to the lower
  // right that the Paper store look has.
  scene.add(new THREE.AmbientLight(0xffffff, 0.5))
  const key = new THREE.DirectionalLight(0xfff0dc, 1.7)
  key.position.set(-3.2, 1.7, -1.4)
  key.castShadow = true
  // The VSM blur below only exists on the high tier; low gets a small
  // PCF map instead, so the blur params are kept minimal there.
  key.shadow.mapSize.setScalar(q === 'low' ? 1024 : 2048)
  key.shadow.camera.left = -4
  key.shadow.camera.right = 4
  key.shadow.camera.top = 4
  key.shadow.camera.bottom = -4
  key.shadow.radius = q === 'low' ? 3 : 12
  key.shadow.blurSamples = q === 'low' ? 4 : 25
  key.shadow.bias = -0.0002
  key.shadow.normalBias = 0.02
  scene.add(key)
  const fill = new THREE.DirectionalLight(0xcfdcff, 0.28)
  fill.position.set(3.5, 1.6, 2.5)
  scene.add(fill)
  const rim = new THREE.DirectionalLight(0xfff2df, 0.35)
  rim.position.set(0, 3.5, -4)
  scene.add(rim)

  // Table: real soft shadows underneath, transparent otherwise.
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(30, 30),
    new THREE.ShadowMaterial({ opacity: 0.2 }),
  )
  ground.rotation.x = -Math.PI / 2
  ground.position.y = groundY
  ground.receiveShadow = true
  scene.add(ground)
}
