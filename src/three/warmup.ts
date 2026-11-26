import * as THREE from 'three'
import { Line2 } from 'three/examples/jsm/lines/Line2.js'
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js'
import { logger } from '../log'
import { acquireSurface } from './surface'
import { addStudioRig, createComposer, detectQuality, outlineMaterial } from './stage'

const log = logger('warmup')

// Throwaway copy of the journal's material recipes. The driver charges for the
// first compile of every program a scene uses (hundreds of ms on a phone, and
// the largest slice of the blank stage when a journal opens), so the shelf's
// idle time pays it instead: a second renderer on the same GPU process now
// finds those programs already compiled. The surface itself is the journal's
// persistent one (see surface.ts), so the context, the studio env map and the
// programs all stay valid for the real scene that mounts later.
export async function warmJournalSurface(): Promise<void> {
  const quality = detectQuality()
  const surface = await acquireSurface('journal', quality)
  const { renderer } = surface
  const t0 = performance.now()

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 10)
  camera.position.set(0, 0, 3)
  // Offscreen scratch frame — the real scene resizes on mount.
  renderer.setSize(256, 256, false)
  addStudioRig(renderer, scene, -1, quality)

  const blank = document.createElement('canvas')
  blank.width = blank.height = 4
  blank.getContext('2d')?.fillRect(0, 0, 4, 4)
  const paperTex = new THREE.CanvasTexture(blank)
  paperTex.colorSpace = THREE.SRGBColorSpace

  // Same parameter set as JournalScene.pageMaterial / edges(): the paper
  // faces carry a map and a bump map, the cut edges are plain matte stock.
  const paper = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.92,
    metalness: 0,
    bumpScale: 0.004,
    envMapIntensity: 0.35,
    side: THREE.FrontSide,
  })
  paper.map = paperTex
  paper.bumpMap = paperTex
  const edge = new THREE.MeshStandardMaterial({
    color: 0xe9e4d4,
    roughness: 0.92,
    envMapIntensity: 0.35,
  })
  const ink = outlineMaterial()
  ink.resolution.set(256, 256)

  const sheetGeo = new THREE.PlaneGeometry(1.5, 2, 4, 4)
  const blockGeo = new THREE.BoxGeometry(1.5, 2, 0.01)
  const lineGeo = new LineGeometry().setPositions([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 0])

  const sheet = new THREE.Mesh(sheetGeo, paper)
  sheet.castShadow = sheet.receiveShadow = true
  const block = new THREE.Mesh(blockGeo, edge)
  block.receiveShadow = true
  block.position.z = -0.02
  const line = new Line2(lineGeo, ink)
  line.position.z = 0.01
  scene.add(sheet, block, line)

  const post = createComposer(renderer, scene, camera, quality)
  try {
    await Promise.resolve(renderer.compileAsync?.(scene, camera))
  } catch (e) {
    log.debug('compileAsync unavailable, warming on the first draw', e)
  }
  // One real frame links everything and builds the shadow maps; the composer
  // tiers also compile their fullscreen passes here.
  post.render()

  post.dispose()
  for (const geo of [sheetGeo, blockGeo, lineGeo]) geo.dispose()
  for (const mat of [paper, edge, ink]) mat.dispose()
  paperTex.dispose()
  renderer.setRenderTarget(null)
  renderer.clear()
  log.info('journal surface warmed', { quality, ms: Math.round(performance.now() - t0) })
}
