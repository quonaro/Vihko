<script setup lang="ts">
import {
  store,
  covers,
  addJournal,
  deleteJournal,
  openJournal,
  renameJournal,
  setCoverImage,
  setCoverTexture,
  journalToJson,
} from '../store'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { update, downloadUpdate } from '../update'
import { glQuality, coverQuality } from '../quality'
import { morphTo, centeredRect, fullRect, type Rect } from '../anim'
import JournalMenuDialog from '../components/JournalMenuDialog.vue'
import CoverTexturePicker from '../components/CoverTexturePicker.vue'
import CoverPicker from '../components/CoverPicker.vue'
import SettingsDialog from '../components/SettingsDialog.vue'
import ShelfSearchDialog from '../components/ShelfSearchDialog.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import EmptyState from '../components/EmptyState.vue'
import { usePrompt } from '../composables/usePrompt'
import { saveFile } from '../saveFile'
import { enterAnim } from '../enterAnim'
import type { CoverTexture, Journal } from '../types'
import type { ShelfAnchor, ShelfJournal, ShelfScene } from '../three/shelfScene'

const { t } = useI18n()
const { prompt } = usePrompt()
const deleteTarget = ref<string | null>(null)
const menuJournalId = ref<string | null>(null)
const menuOn = ref(false)
const searchOn = ref(false)
const coverOn = ref(false)
const coverTextureOn = ref(false)
const settingsOn = ref(false)

const menuJournal = computed(() => store.journals.find((j) => j.id === menuJournalId.value) ?? null)
const updateLabel = computed(() => {
  switch (update.dl) {
    case 'downloading':
      return t('shelf.downloading', { n: update.progress })
    case 'ready':
      return t('shelf.installUpdate', { v: update.latest })
    case 'error':
      return t('shelf.downloadFailed')
    default:
      return t('shelf.updateAvailable', { v: update.latest })
  }
})
function openSearch() {
  searchOn.value = true
}

function openFromSearch(id: string) {
  searchOn.value = false
  openJournal(id)
}

// --- WebGL shelf -----------------------------------------------------------

const glCanvas = ref<HTMLCanvasElement>()
const glOk = ref(false)
const glFailed = ref(false)
const entering = ref(false)
const showGlLabels = ref(false)
const anchors = ref<ShelfAnchor[]>([])
let scene: ShelfScene | null = null
let sceneRequest = 0
let labelTimer: ReturnType<typeof setTimeout> | undefined
const labelEls = new Map<string, HTMLElement>()
const titleEls = new Map<string, HTMLElement>()

const sceneJournals = (): ShelfJournal[] =>
  store.journals.map((j) => ({
    id: j.id,
    color: covers[j.cover % covers.length],
    coverImg: j.coverImg,
    coverTexture: j.coverTexture,
  }))

// Rebuild book meshes when the row or a cover's look (color/photo/texture) changes —
// same signature the scene uses for its texture cache.
const journalSig = computed(() =>
  store.journals
    .map((j) => `${j.id}${j.cover}${j.coverImg?.slice(-24) ?? ''}${j.coverTexture ?? 'paper'}`)
    .join(''),
)

function setLabelEl(id: string, el: unknown) {
  if (el instanceof HTMLElement) labelEls.set(id, el)
  else labelEls.delete(id)
}

function setTitleEl(id: string, el: unknown) {
  if (el instanceof HTMLElement) titleEls.set(id, el)
  else titleEls.delete(id)
}

// Per-frame anchors from the scene: pin labels imperatively (no Vue churn)
// while the scene renders the books and tracks pointer interaction.
function onOverlay(list: ShelfAnchor[]) {
  anchors.value = list
  for (const a of list) {
    const el = labelEls.get(a.id)
    if (el) {
      el.style.display = a.onScreen && a.label ? '' : 'none'
      if (a.label) {
        el.style.left = `${a.label.x}px`
        el.style.top = `${a.label.y}px`
      }
    }
    const tl = titleEls.get(a.id)
    if (tl) {
      tl.style.display = a.onScreen && a.title ? '' : 'none'
      if (a.title) {
        tl.style.left = `${a.title.x}px`
        tl.style.top = `${a.title.y}px`
      }
    }
  }
}

// A fixed div dressed up as the journal cover — morph source and the
// fullscreen hand-off card share the same look.
function coverDiv(j: Journal, rect?: Rect) {
  const src = document.createElement('div')
  Object.assign(src.style, {
    position: 'fixed',
    left: rect ? `${rect.left}px` : '0',
    top: rect ? `${rect.top}px` : '0',
    width: rect ? `${rect.width}px` : '100%',
    height: rect ? `${rect.height}px` : '100%',
    backgroundColor: covers[j.cover % covers.length],
  })
  if (rect) src.style.borderRadius = '4.5%'
  if (j.coverImg) {
    src.style.backgroundImage = `url(${j.coverImg})`
    src.style.backgroundSize = 'cover'
    src.style.backgroundPosition = 'center'
  }
  return src
}

// The 3D transition ended with the cover (dive) or the opened paper block
// (open) filling the view — hold a matching fullscreen card over the
// freshly mounted journal while it loads its scene underneath.
function enterDone(id: string, kind: 'dive' | 'open') {
  const j = store.journals.find((x) => x.id === id)
  if (!j) {
    openJournal(id)
    return
  }
  const src = coverDiv(j)
  if (kind === 'open') {
    src.style.backgroundImage = ''
    src.style.backgroundColor = '#ffffff' // match the neutral-white page block
  }
  document.body.appendChild(src)
  morphTo(fullRect(), src, { delay: 140 })
  src.remove()
  openJournal(id)
}

function openFromScene(id: string) {
  const j = store.journals.find((x) => x.id === id)
  if (!j || !scene) {
    openJournal(id)
    return
  }
  const kind = enterAnim.value
  if (kind !== 'morph' && scene.beginEnter(id, kind, () => enterDone(id, kind))) {
    entering.value = true
    return
  }
  // Flat morph — the chosen 'morph' style and the fallback when the scene
  // can't run the 3D move (book gone or a transition already running).
  const r = scene.screenRect(id)
  const cr = glCanvas.value?.getBoundingClientRect()
  if (r && cr) {
    // morphTo needs a laid-out element: pin an invisible div over the book.
    const src = coverDiv(j, {
      left: cr.left + r.left,
      top: cr.top + r.top,
      width: r.width,
      height: r.height,
    })
    document.body.appendChild(src)
    morphTo(centeredRect(), src)
    src.remove()
  }
  setTimeout(() => openJournal(id), 110)
}

async function startScene() {
  const request = ++sceneRequest
  const canvas = glCanvas.value
  if (!canvas) return
  window.clearTimeout(labelTimer)
  glOk.value = false
  glFailed.value = false
  showGlLabels.value = false
  try {
    // three.js stays out of the main bundle — loaded with the shelf view.
    const { ShelfScene } = await import('../three/shelfScene')
    if (request !== sceneRequest || !canvas.isConnected) return
    scene = new ShelfScene(canvas, {
      onPick: (id) => openFromScene(id),
      onLongPress: openJournalMenu,
      onOverlay: (a) => onOverlay(a),
    })
    scene.setJournals(sceneJournals())
    scene.start()
    glOk.value = true
    labelTimer = window.setTimeout(() => {
      if (request === sceneRequest && scene) showGlLabels.value = true
    }, 500)
  } catch {
    scene = null
    if (request === sceneRequest && canvas.isConnected) glFailed.value = true
  }
}

function stopScene() {
  sceneRequest++
  window.clearTimeout(labelTimer)
  showGlLabels.value = false
  scene?.dispose()
  scene = null
  glOk.value = false
  anchors.value = []
}

onMounted(startScene)
onBeforeUnmount(stopScene)

watch(journalSig, () => scene?.setJournals(sceneJournals()))
// Quality toggles can't patch a live scene — the renderer pipeline and the
// cover texture sizes are fixed at construction — so rebuild it instead.
watch([glQuality, coverQuality], () => {
  stopScene()
  void startScene()
})
function openJournalMenu(id: string) {
  menuJournalId.value = id
  menuOn.value = true
}

function requestDelete(id: string) {
  menuOn.value = false
  deleteTarget.value = id
}

function confirmDeleteJournal() {
  const id = deleteTarget.value
  if (!id) return
  deleteJournal(id)
  if (menuJournalId.value === id) menuJournalId.value = null
  deleteTarget.value = null
}

async function rename() {
  const journal = menuJournal.value
  if (!journal) return
  menuOn.value = false
  const title = await prompt({
    title: t('shelf.rename'),
    value: journal.title,
    placeholder: t('shelf.renamePrompt'),
  })
  if (title) renameJournal(journal.id, title)
}

function exportJournal() {
  const journal = menuJournal.value
  const json = journal && journalToJson(journal.id)
  if (!json) return
  menuOn.value = false
  saveFile(`${journal!.title}.paper.json`, new Blob([json], { type: 'application/json' }))
}

function openCoverPicker() {
  menuOn.value = false
  coverOn.value = true
}

function openCoverTexturePicker() {
  menuOn.value = false
  coverTextureOn.value = true
}

function applyCoverTexture(texture: CoverTexture) {
  if (menuJournalId.value) setCoverTexture(menuJournalId.value, texture)
  coverTextureOn.value = false
}

function applyCover(src: string | null) {
  if (menuJournalId.value) setCoverImage(menuJournalId.value, src)
  coverOn.value = false
}
</script>

<template>
  <div class="shelf" :class="{ 'is-entering': entering }">
    <button
      v-if="update.status === 'available'"
      class="update-banner"
      @click="downloadUpdate"
    >
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 3 22 20H2Z" />
        <path d="M12 9.5v4.5" />
        <circle cx="12" cy="17" r="0.5" fill="currentColor" />
      </svg>
      {{ updateLabel }}
    </button>

    <nav class="topbar">
      <div class="top-actions">
        <button class="icon-btn search-btn" :class="{ on: searchOn }" @click="openSearch" :title="t('shelf.search')">
          <svg viewBox="0 0 24 24" width="20" height="20"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15.5 15.5 L21 21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
        <button class="icon-btn settings-btn" @click="settingsOn = true" :title="t('shelf.settings')" :aria-label="t('shelf.settings')">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M3 5h7" />
            <path d="M14 5h7" />
            <circle cx="12" cy="5" r="2" />
            <path d="M3 12h3" />
            <path d="M10 12h11" />
            <circle cx="8" cy="12" r="2" />
            <path d="M3 19h11" />
            <path d="M18 19h3" />
            <circle cx="16" cy="19" r="2" />
          </svg>
          <span v-if="update.status === 'available'" class="update-dot" />
        </button>
      </div>
    </nav>

    <header>
      <h1>{{ t('shelf.title') }}</h1>
      <p class="count">
        {{ t('shelf.count', store.journals.length) }}
      </p>
    </header>

    <div
      class="covers"
    >
      <canvas ref="glCanvas" class="shelf3d" v-show="glOk"></canvas>
      <span
        v-for="j in store.journals"
        :key="j.id"
        :ref="(el) => setLabelEl(j.id, el)"
        class="pages-count gl-label"
        :class="{ delayed: !showGlLabels }"
      >{{ t('journal.count', j.pages.length) }}</span>
      <span
        v-for="j in store.journals"
        :key="j.id"
        :ref="(el) => setTitleEl(j.id, el)"
        class="book-title gl-label"
        :class="{ delayed: !showGlLabels }"
      >{{ j.title }}</span>
      <EmptyState v-if="glFailed" class="webgl-error" :title="t('shelf.webglError')">
        <template #icon>
          <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 3 20 7.5v9L12 21l-8-4.5v-9Z"/>
            <path d="M12 12 20 7.5M12 12 4 7.5M12 12v9"/>
          </svg>
        </template>
      </EmptyState>
      <EmptyState
        v-if="!store.journals.length"
        class="shelf-empty"
        :title="t('shelf.emptyTitle')"
        :hint="t('shelf.emptyHint')"
      >
        <template #icon>
          <svg viewBox="0 0 24 24" width="52" height="52" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M6.5 3.8h9A2.5 2.5 0 0 1 18 6.3v11.4a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 4 17.7V6.3a2.5 2.5 0 0 1 2.5-2.5Z"/>
            <path d="M8.5 3.8v16.4"/>
            <path d="M11.5 8.5h4"/>
          </svg>
        </template>
      </EmptyState>
    </div>

    <footer>
      <button class="round" @click="addJournal" :title="t('shelf.newJournal')">
        <svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 5 L12 19 M5 12 L19 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
    </footer>

    <JournalMenuDialog
      v-model:open="menuOn"
      :journal="menuJournal"
      @rename="rename"
      @export="exportJournal"
      @cover="openCoverPicker"
      @cover-texture="openCoverTexturePicker"
      @delete="menuJournal && requestDelete(menuJournal.id)"
    />

    <CoverTexturePicker
      v-model:open="coverTextureOn"
      :journal="menuJournal"
      @select="applyCoverTexture"
    />

    <CoverPicker v-model:open="coverOn" :journal="menuJournal" @select="applyCover" />

    <SettingsDialog v-model:open="settingsOn" />

    <ShelfSearchDialog v-model:open="searchOn" @select="openFromSearch" />
    <ConfirmDialog
      :open="deleteTarget !== null"
      :title="t('dlg.deleteJournalTitle')"
      :message="t('dlg.deleteJournalMessage', { title: store.journals.find((j) => j.id === deleteTarget)?.title ?? '' })"
      @confirm="confirmDeleteJournal"
      @cancel="deleteTarget = null"
    />
  </div>
</template>

<style scoped>
.shelf {
  position: relative;
  isolation: isolate;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: var(--paper-text);
  background: var(--paper-shell);
}
.topbar {
  position: relative;
  z-index: 10;
  display: flex;
  justify-content: flex-end;
  align-items: center;
  padding: 18px 26px 0;
  pointer-events: none;
}
.topbar .icon-btn { pointer-events: auto; }
.top-actions { display: flex; gap: 8px; }
.icon-btn {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  color: var(--paper-muted);
  font-size: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.icon-btn.on {
  color: var(--paper-text);
  background: var(--paper-hover);
}
@media (hover: hover) {
  .icon-btn:hover {
    color: var(--paper-text);
    background: var(--paper-hover);
  }
}
header {
  position: relative;
  z-index: 10;
  padding: 13px 0 8px;
  text-align: center;
  pointer-events: none;
}
h1 {
  color: var(--paper-text);
  font-size: clamp(22px, 2vw, 28px);
  font-weight: 650;
  letter-spacing: -.035em;
}
.count {
  color: var(--paper-muted);
  font-size: 12px;
  margin-top: 4px;
}
/* The shelf stage is full-bleed: the canvas runs under the header/footer
   chrome so a zoomed book is never clipped by a footer edge — same layout
   contract as JournalView's .stage. */
.covers {
  position: absolute;
  inset: 0;
  overflow: hidden;
}
.shelf.is-entering .covers {
  z-index: 20;
}
.shelf3d {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  touch-action: none;
}
.shelf.is-entering .shelf3d {
  pointer-events: none;
}
.gl-label {
  position: absolute;
  margin: 0;
  transform: translate(-50%, 4px);
  pointer-events: none;
  white-space: nowrap;
}
.gl-label.delayed { visibility: hidden; }
.pages-count {
  color: var(--paper-muted);
  font-size: 12px;
}
.pages-count.gl-label { margin: 0; }
.book-title {
  color: var(--paper-text);
  font-size: 13px;
  font-weight: 600;
  max-width: 170px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.book-title.gl-label { margin: 0; }
.shelf-empty {
  position: absolute;
  inset: 0;
  color: var(--paper-text);
  pointer-events: none;
}
.webgl-error {
  position: absolute;
  inset: 50% 24px auto;
  margin: 0;
  transform: translateY(-50%);
  color: var(--paper-text);
  pointer-events: none;
}
footer {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 10;
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 18px;
  padding: 20px 0 max(30px, env(safe-area-inset-bottom));
}
.round {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: #191a18;
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 12px 24px rgba(32,33,31,.18), 0 2px 5px rgba(32,33,31,.14);
  transition: transform .25s cubic-bezier(.2,.8,.2,1), box-shadow .25s ease, background .2s ease;
}
@media (hover: hover) {
  .round:hover {
    background: #333430;
    transform: translateY(-3px) scale(1.04);
    box-shadow: 0 16px 30px rgba(32,33,31,.22), 0 3px 7px rgba(32,33,31,.16);
  }
}
.round svg { display: block; }

.settings-btn { position: relative; }
.update-dot {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #2a8097;
}
.update-banner {
  position: relative;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  padding: max(9px, env(safe-area-inset-top)) 14px 9px;
  background: rgba(234, 179, 8, .1);
  border-bottom: 1px solid rgba(234, 179, 8, .3);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  color: var(--paper-text);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  text-align: center;
  cursor: pointer;
}
.update-banner svg { flex-shrink: 0; color: var(--warn-icon); }
@media (hover: hover) {
  .update-banner:hover { background: rgba(234, 179, 8, .18); }
}
@media (max-width: 600px) {
  .topbar { padding: 14px 16px 0; }
  header { padding-top: 18px; }
  footer { padding-bottom: max(24px, env(safe-area-inset-bottom)); }
}
</style>
