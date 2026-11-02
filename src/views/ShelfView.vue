<script setup lang="ts">
import {
  store, covers, addJournal, deleteJournal, openJournal,
  renameJournal, setCoverImage, journalToJson,
} from '../store'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { setLocale } from '../i18n'
import { setTheme, theme } from '../theme'
import { morphTo, centeredRect } from '../anim'
import { presetCovers } from '../covers'
import { imageFileToPhoto } from '../ink/ops'
import MobileSlider from '../components/MobileSlider.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import { usePrompt } from '../composables/usePrompt'
import { saveFile } from '../saveFile'
import type { ShelfAnchor, ShelfJournal, ShelfScene } from '../three/shelfScene'
import {
  deviceTilt, disableDeviceTilt, enableDeviceTilt, startDeviceTiltByDefault, supportsDeviceTilt,
} from '../three/deviceTilt'

const { t, locale } = useI18n()
const { prompt } = usePrompt()
const deleteTarget = ref<string | null>(null)
const selectedId = ref<string | null>(null)
const query = ref('')
const searchOn = ref(false)
const coverOn = ref(false)
const settingsOn = ref(false)
const coverInput = ref<HTMLInputElement>()

const selected = computed(() => store.journals.find((j) => j.id === selectedId.value) ?? null)
const results = computed(() => {
  const q = query.value.trim().toLowerCase()
  return q ? store.journals.filter((j) => j.title.toLowerCase().includes(q)) : store.journals
})

function openSearch() {
  query.value = ''
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
const showGlLabels = ref(false)
const anchors = ref<ShelfAnchor[]>([])
const hoverId = ref<string | null>(null)
const uiHold = ref(false) // pointer sits on a DOM overlay button
// Touch devices have no hover — keep the action buttons visible.
const coarse = typeof matchMedia === 'function' && matchMedia('(hover: none)').matches
const motionAvailable = coarse && supportsDeviceTilt()
let scene: ShelfScene | null = null
let sceneRequest = 0
let labelTimer: ReturnType<typeof setTimeout> | undefined
const labelEls = new Map<string, HTMLElement>()

const sceneJournals = (): ShelfJournal[] =>
  store.journals.map((j) => ({
    id: j.id,
    title: j.title,
    color: covers[j.cover % covers.length],
    coverImg: j.coverImg,
  }))

// Rebuild book meshes when the row or a cover's look (title/color/photo)
// changes — same signature the scene uses for its texture cache.
const journalSig = computed(() =>
  store.journals
    .map((j) => `${j.id}${j.title}${j.cover}${j.coverImg?.slice(-24) ?? ''}`)
    .join(''),
)

function setLabelEl(id: string, el: unknown) {
  if (el instanceof HTMLElement) labelEls.set(id, el)
  else labelEls.delete(id)
}

// Per-frame anchors from the scene: pin labels imperatively (no Vue churn)
// and track which book the pointer is over for the del/⋮ overlay buttons.
function onOverlay(list: ShelfAnchor[]) {
  anchors.value = list
  for (const a of list) {
    const el = labelEls.get(a.id)
    if (!el) continue
    el.style.display = a.onScreen && a.label ? '' : 'none'
    if (a.label) {
      el.style.left = `${a.label.x}px`
      el.style.top = `${a.label.y}px`
    }
  }
  const hov = list.find((a) => a.hover && a.onScreen)
  if (hov) hoverId.value = hov.id
  else if (!uiHold.value) hoverId.value = null
}

// On touch there is no hover: action buttons sit below each book.
const belowBook = (a: ShelfAnchor, dx: number) =>
  a.actions ? { x: a.actions.x + dx, y: a.actions.y + 18 } : null

const delBtns = computed(() =>
  anchors.value
    .filter(
      (a) =>
        a.onScreen && (coarse ? a.actions : a.del) &&
        (coarse || a.id === hoverId.value),
    )
    .map((a) => ({
      id: a.id,
      ...(coarse ? belowBook(a, -18)! : a.del!),
    })),
)

const selBtns = computed(() =>
  anchors.value
    .filter(
      (a) =>
        a.onScreen && (coarse ? a.actions : a.sel) &&
        (coarse || a.id === hoverId.value || a.id === selectedId.value),
    )
    .map((a) => ({
      id: a.id,
      ...(coarse ? belowBook(a, 18)! : a.sel!),
      on: a.id === selectedId.value,
    })),
)

function openFromScene(id: string) {
  const j = store.journals.find((x) => x.id === id)
  const r = scene?.screenRect(id)
  const cr = glCanvas.value?.getBoundingClientRect()
  if (j && r && cr) {
    // morphTo needs a laid-out element: pin an invisible div over the book.
    const src = document.createElement('div')
    Object.assign(src.style, {
      position: 'fixed',
      left: `${cr.left + r.left}px`,
      top: `${cr.top + r.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
      borderRadius: '3px 10px 10px 3px',
      backgroundColor: covers[j.cover % covers.length],
    })
    if (j.coverImg) {
      src.style.backgroundImage = `url(${j.coverImg})`
      src.style.backgroundSize = 'cover'
      src.style.backgroundPosition = 'center'
    }
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
      onOverlay: (a) => onOverlay(a),
    })
    scene.setJournals(sceneJournals())
    scene.setSelected(selectedId.value)
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
  hoverId.value = null
}

onMounted(() => {
  if (motionAvailable) void startDeviceTiltByDefault()
  startScene()
})
onBeforeUnmount(stopScene)

watch(journalSig, () => scene?.setJournals(sceneJournals()))
watch(selectedId, (v) => scene?.setSelected(v))

function select(id: string, ev: Event) {
  ev.stopPropagation()
  selectedId.value = selectedId.value === id ? null : id
}

function requestDelete(id: string, ev: Event) {
  ev.stopPropagation()
  deleteTarget.value = id
}

function confirmDeleteJournal() {
  const id = deleteTarget.value
  if (!id) return
  deleteJournal(id)
  if (selectedId.value === id) selectedId.value = null
  deleteTarget.value = null
}

async function rename() {
  if (!selected.value) return
  const title = await prompt({
    title: t('shelf.rename'),
    value: selected.value.title,
    placeholder: t('shelf.renamePrompt'),
  })
  if (title) renameJournal(selected.value.id, title)
}

function exportJournal() {
  const json = selected.value && journalToJson(selected.value.id)
  if (!json) return
  saveFile(`${selected.value!.title}.paper.json`, new Blob([json], { type: 'application/json' }))
}

function applyCover(src: string | null) {
  if (selectedId.value) setCoverImage(selectedId.value, src)
  coverOn.value = false
}

async function onCoverPicked(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  const img = await imageFileToPhoto(file, 800)
  applyCover(img.src)
}

function toggleMotionTilt() {
  if (deviceTilt.active) disableDeviceTilt()
  else void enableDeviceTilt()
}
</script>

<template>
  <div class="shelf">
    <nav class="topbar">
      <div class="top-actions">
        <button class="icon-btn search-btn" :class="{ on: searchOn }" @click="openSearch" :title="t('shelf.search')">
          <svg viewBox="0 0 24 24" width="20" height="20"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15.5 15.5 L21 21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
        <button class="icon-btn settings-btn" @click="settingsOn = true" :title="t('shelf.settings')" :aria-label="t('shelf.settings')">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="4" />
            <path d="M10 2.8h4v2.6a7.4 7.4 0 0 1 1.6.7l1.8-1.3 2.8 2.8-1.3 1.8a7.4 7.4 0 0 1 .7 1.6h2.6v4h-2.6a7.4 7.4 0 0 1-.7 1.6l1.3 1.8-2.8 2.8-1.8-1.3a7.4 7.4 0 0 1-1.6.7v2.6h-4v-2.6a7.4 7.4 0 0 1-1.6-.7l-1.8 1.3-2.8-2.8 1.3-1.8a7.4 7.4 0 0 1-.7-1.6H1.8v-4h2.6a7.4 7.4 0 0 1 .7-1.6L3.8 7.6l2.8-2.8 1.8 1.3a7.4 7.4 0 0 1 1.6-.7Z" />
          </svg>
        </button>
      </div>
    </nav>

    <header>
      <h1>{{ selected?.title ?? t('shelf.title') }}</h1>
      <p class="count">
        {{ selected ? t('journal.count', selected.pages.length) : t('shelf.count', store.journals.length) }}
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
      <button
        v-for="b in delBtns"
        :key="b.id"
        class="del gl-del"
        :style="{ left: `${b.x}px`, top: `${b.y}px` }"
        :aria-label="t('shelf.delete')"
        :title="t('shelf.delete')"
        @pointerenter="uiHold = true"
        @pointerleave="uiHold = false"
        @click="requestDelete(b.id, $event)"
      >
        ×
      </button>
      <button
        v-for="b in selBtns"
        :key="b.id"
        class="sel gl-sel"
        :class="{ on: b.on }"
        :style="{ left: `${b.x}px`, top: `${b.y}px` }"
        @pointerenter="uiHold = true"
        @pointerleave="uiHold = false"
        @click="select(b.id, $event)"
      >⋯</button>
      <p v-if="glFailed" class="webgl-error" role="status">{{ t('shelf.webglError') }}</p>
      <p v-if="!store.journals.length" class="empty">{{ t('shelf.noMatch') }}</p>
    </div>

    <footer>
      <template v-if="selected">
        <button class="round small" @click="rename" :title="t('shelf.rename')">
          <svg viewBox="0 0 24 24" width="17" height="17"><path d="M4 20 L4.8 16.2 L15.9 5.1 L18.9 8.1 L7.8 19.2 Z M13.9 7.1 L16.9 10.1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>
        </button>
        <button class="round small" @click="exportJournal" :title="t('shelf.export')">
          <svg viewBox="0 0 24 24" width="17" height="17"><path d="M12 4 L12 15 M7.5 10.5 L12 15 L16.5 10.5 M5.5 19 L18.5 19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button class="round small cover-btn" @click="coverOn = true" :title="t('shelf.cover')">
          <svg viewBox="0 0 24 24" width="17" height="17"><rect x="4.5" y="5" width="15" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="9.5" cy="10" r="1.5" fill="currentColor"/><path d="M5.5 16.5 L10.5 11.5 L14 15 L16.5 12.5 L19 15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button class="round small danger" @click="requestDelete(selected.id, $event)" :title="t('shelf.delete')">
          <svg viewBox="0 0 24 24" width="17" height="17"><path d="M4.5 6.5 L19.5 6.5 M9.2 6.5 L9.7 4.5 L14.3 4.5 L14.8 6.5 M6.5 6.5 L7.4 19.5 L16.6 19.5 L17.5 6.5 M10 10 L10.4 16 M14 10 L13.6 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </template>
      <button class="round" @click="addJournal" :title="t('shelf.newJournal')">
        <svg viewBox="0 0 24 24" width="22" height="22"><path d="M12 5 L12 19 M5 12 L19 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
    </footer>

    <MobileSlider v-model:open="coverOn" :title="t('shelf.cover')" no-scrollbar>
      <p class="hint cover-hint">{{ selected?.title }}</p>
      <div class="cover-grid">
        <button
          v-for="c in presetCovers"
          :key="c.id"
          class="cover-option"
          :style="{ backgroundImage: `url(${c.src})` }"
          @click="applyCover(c.src)"
        />
        <button class="cover-option upload" @click="coverInput?.click()">
          {{ t('shelf.uploadCover') }}
        </button>
        <button v-if="selected?.coverImg" class="cover-option plain" @click="applyCover(null)">
          {{ t('shelf.removeCover') }}
        </button>
      </div>
      <input ref="coverInput" type="file" accept="image/*" hidden @change="onCoverPicked" />
    </MobileSlider>

    <MobileSlider v-model:open="settingsOn" :title="t('shelf.settings')" size="sm">
      <div class="set-row">
        <span class="set-label">{{ t('shelf.theme') }}</span>
        <div class="seg">
          <button
            class="seg-btn"
            :class="{ on: theme === 'light' }"
            :aria-pressed="theme === 'light'"
            @click="setTheme('light')"
          >{{ t('shelf.themeLight') }}</button>
          <button
            class="seg-btn"
            :class="{ on: theme === 'dark' }"
            :aria-pressed="theme === 'dark'"
            @click="setTheme('dark')"
          >{{ t('shelf.themeDark') }}</button>
        </div>
      </div>
      <div v-if="motionAvailable" class="set-row">
        <span class="set-label">{{ t('shelf.motionTilt') }}</span>
        <button
          class="seg-btn motion-setting-btn"
          :class="{ on: deviceTilt.active }"
          :aria-pressed="deviceTilt.active"
          @click="toggleMotionTilt"
        >{{ t(deviceTilt.active ? 'shelf.tiltDisable' : 'shelf.tiltEnable') }}</button>
      </div>
      <div class="set-row">
        <span class="set-label">{{ t('shelf.language') }}</span>
        <div class="seg">
          <button class="seg-btn" :class="{ on: locale === 'en' }" @click="setLocale('en')">English</button>
          <button class="seg-btn" :class="{ on: locale === 'ru' }" @click="setLocale('ru')">Русский</button>
        </div>
      </div>
    </MobileSlider>

    <MobileSlider v-model:open="searchOn" :title="t('shelf.search')" size="sm">
      <input
        v-model="query"
        class="search-input"
        :placeholder="t('shelf.searchPh')"
        autofocus
      />
      <div class="search-results">
        <button
          v-for="j in results"
          :key="j.id"
          class="search-hit"
          @click="openFromSearch(j.id)"
        >
          <span
            class="hit-cover"
            :style="j.coverImg
              ? { backgroundImage: `url(${j.coverImg})`, backgroundSize: 'cover', backgroundPosition: 'center' }
              : { background: covers[j.cover % covers.length] }"
          />
          <span class="hit-text">
            <span class="hit-title">{{ j.title }}</span>
            <span class="hit-count">{{ t('journal.count', j.pages.length) }}</span>
          </span>
        </button>
        <p v-if="!results.length" class="hint search-none">{{ t('shelf.noMatch') }}</p>
      </div>
    </MobileSlider>
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
  display: flex;
  justify-content: flex-end;
  align-items: center;
  padding: 18px 26px 0;
}
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
.search-input {
  width: 100%;
  padding: 10px 16px;
  border-radius: 12px;
  border: 1px solid var(--chrome-border);
  background: var(--chrome-input-bg);
  color: var(--chrome-text);
  font-size: 14px;
  outline: none;
}
.search-input:focus { border-color: #d9a441; }
.search-results {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.search-hit {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 10px;
  border-radius: 10px;
  text-align: left;
}
@media (hover: hover) {
  .search-hit:hover { background: var(--chrome-hover); }
}
.hit-cover {
  width: 30px;
  height: 40px;
  border-radius: 2px 5px 5px 2px;
  flex-shrink: 0;
  box-shadow: inset 0 0 0 1px rgba(255,255,255,.15);
}
.hit-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.hit-title {
  color: var(--chrome-text);
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hit-count { color: var(--chrome-muted); font-size: 12px; margin-top: 2px; }
.search-none { text-align: center; padding: 14px 0; }
header {
  padding: 13px 0 8px;
  text-align: center;
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
.covers {
  flex: 1;
  position: relative;
  min-height: 0;
  overflow: hidden;
}
.shelf3d {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  touch-action: none;
}
.gl-label {
  position: absolute;
  margin: 0;
  transform: translate(-50%, 4px);
  pointer-events: none;
  white-space: nowrap;
}
.gl-label.delayed { visibility: hidden; }
.del.gl-del, .sel.gl-sel {
  position: absolute;
  opacity: 1;
  transform: translate(-50%, -50%);
  z-index: 20;
}
.pages-count {
  color: var(--paper-muted);
  font-size: 12px;
}
.pages-count.gl-label { margin: 0; }
.del {
  position: absolute;
  top: -10px;
  right: -10px;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: #4a4a4e;
  color: #ccc;
  font-size: 15px;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.15s;
}
.del.armed {
  opacity: 1;
  width: auto;
  padding: 0 10px;
  border-radius: 13px;
  background: #a33;
  font-size: 12px;
}
.sel {
  position: absolute;
  bottom: 26px;
  right: -8px;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: #4a4a4e;
  color: #ccc;
  font-size: 15px;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.15s;
}
.sel.on { opacity: 1; background: #d9a441; color: #222; }
.empty { color: var(--paper-muted); margin: auto; }
.webgl-error {
  position: absolute;
  inset: 50% 24px auto;
  margin: 0;
  transform: translateY(-50%);
  color: var(--paper-muted);
  text-align: center;
}
footer {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 18px;
  padding: 20px 0 max(30px, env(safe-area-inset-bottom));
}
.round {
  width: 42px;
  height: 42px;
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
.round.small {
  width: 40px;
  height: 40px;
  font-size: 17px;
}
.round.danger { color: #a33; }
.round svg { display: block; }

.cover-hint { margin: -4px 0 14px; }
.hint { color: #9a9a9e; font-size: 13px; }
.set-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
}
.set-row + .set-row { margin-top: 14px; }
.set-label { color: var(--chrome-text); font-size: 14px; }
.seg {
  display: flex;
  gap: 3px;
  padding: 3px;
  border-radius: 10px;
  background: var(--chrome-control-bg);
}
.seg-btn {
  padding: 7px 18px;
  border-radius: 8px;
  color: var(--chrome-muted);
  font-size: 13px;
  font-weight: 650;
}
.seg-btn.on { background: #d9a441; color: #222; }
.cover-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
}
.cover-option {
  aspect-ratio: 34 / 48;
  border-radius: 8px;
  background-size: cover;
  background-position: center;
  border: 1px solid rgba(255,255,255,0.1);
  cursor: pointer;
  color: #ccc;
  font-size: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 6px;
}
.cover-option.upload, .cover-option.plain {
  background: rgba(255,255,255,0.05);
}
@media (max-width: 600px) {
  .topbar { padding: 14px 16px 0; }
  header { padding-top: 18px; }
  footer { padding-bottom: max(24px, env(safe-area-inset-bottom)); }
}
</style>
