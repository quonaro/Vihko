<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { store, currentJournal, addPage, deletePage, openPage, closeToShelf } from '../store'
import { useI18n } from 'vue-i18n'
import { initInk } from '../ink/engine'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import MobileSlider from '../components/MobileSlider.vue'
import EmptyState from '../components/EmptyState.vue'
import PagePreview from '../components/PagePreview.vue'
import { renderMode } from '../renderMode'
import { logger } from '../log'
import { useLongPress } from '../longPress'

const log = logger('journal')
import type { JournalScene } from '../three/journalScene'
import { canTurnStack } from '../three/layout'

const { t } = useI18n()
const journal = computed(() => currentJournal())
const deleteTarget = ref<string | null>(null)
const pageMenuTarget = ref<string | null>(null)
const mode = computed({
  get: () => store.journalMode,
  set: (value) => {
    store.journalMode = value
  },
})
const pageIdx = computed({
  get: () => store.journalPageIdx,
  set: (value) => {
    store.journalPageIdx = value
  },
})
const glCanvas = ref<HTMLCanvasElement>()
const glOk = ref(false)
const glFailed = ref(false)
const currentPage = computed(() => journal.value?.pages[pageIdx.value] ?? null)
const lastPage = computed(() => (journal.value?.pages.length ?? 0) <= 1)
const press = useLongPress(
  (id) => {
    pageMenuTarget.value = id
  },
  { enabled: () => !lastPage.value },
)
let scene: JournalScene | null = null
let sceneRequest = 0

function openFlatPage(id: string) {
  if (press.consumeClick()) return
  openPage(id)
}

function requestDeletePage(id: string) {
  pageMenuTarget.value = null
  deleteTarget.value = id
}

function confirmDeletion() {
  if (!deleteTarget.value) return
  deletePage(deleteTarget.value)
  deleteTarget.value = null
}

function flip(dir: 1 | -1) {
  if (scene) {
    if (scene.busy) return
    scene.flip(dir) // pageIdx syncs via onFlipDone
    return
  }
  const total = journal.value?.pages.length ?? 0
  if (canTurnStack(dir, pageIdx.value, total)) {
    log.debug('flip without scene', { dir, page: pageIdx.value })
    pageIdx.value += dir
  }
}

async function startScene() {
  const request = ++sceneRequest
  const canvas = glCanvas.value
  if (!canvas) return
  glOk.value = false
  glFailed.value = false
  try {
    const ink = await initInk()
    // three.js stays out of the main bundle — loaded when a journal opens.
    const { JournalScene } = await import('../three/journalScene')
    if (request !== sceneRequest || !canvas.isConnected) return
    scene = new JournalScene(canvas, ink, {
      onPageClick: (id) => openPage(id),
      onLongPressPage: (id) => {
        if (!lastPage.value) pageMenuTarget.value = id
      },
      onFlipDone: (dir) => {
        pageIdx.value = Math.max(0, pageIdx.value + dir)
      },
    })
    scene.setMode(mode.value)
    scene.setPages(journal.value?.pages ?? [])
    scene.setPage(pageIdx.value)
    if (mode.value === 'overview') scene.setOverviewFocus(store.journalOverviewIdx)
    scene.start()
    // Keep the loading stage blank until the first complete 3D frame is ready.
    const s = scene
    s.ready.then(() => {
      if (scene === s) glOk.value = true
    })
  } catch (e) {
    log.warn('journal scene failed to start, showing the unavailable message', e)
    scene = null
    if (request === sceneRequest && canvas.isConnected) glFailed.value = true
  }
}

function stopScene() {
  sceneRequest++
  scene?.dispose()
  scene = null
  glOk.value = false
}

onMounted(syncScene)
onBeforeUnmount(stopScene)
watch(renderMode, syncScene, { flush: 'post' })

function syncScene() {
  if (renderMode.value === '3d') void startScene()
  else stopScene()
}

watch(mode, (m) => {
  scene?.setMode(m)
  if (m === 'overview') scene?.setOverviewFocus(store.journalOverviewIdx)
})
watch(
  () => journal.value?.pages.map((p) => p.id).join(','),
  () => {
    pageIdx.value = Math.max(0, Math.min(pageIdx.value, (journal.value?.pages.length ?? 1) - 1))
    scene?.setPages(journal.value?.pages ?? [])
  },
)
watch(pageIdx, (v) => {
  if (scene && !scene.busy) scene.setPage(v)
})
watch(lastPage, (v) => {
  if (v) pageMenuTarget.value = null
})
</script>

<template>
  <div class="journal-view" v-if="journal">
    <button class="back" @click="closeToShelf">{{ t('journal.back') }}</button>

    <nav class="view-modes">
      <button
        class="icon-btn"
        :class="{ on: mode === 'stack' }"
        @click="mode = 'stack'"
        :title="t('journal.stackView')"
        :aria-label="t('journal.stackView')"
      >
        <svg viewBox="0 0 24 24" width="19" height="19"><path d="M4 5 Q8 3.5 12 5 Q16 3.5 20 5 L20 18 Q16 16.5 12 18 Q8 16.5 4 18 Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 5 L12 18" stroke="currentColor" stroke-width="1.8"/></svg>
      </button>
      <button
        class="icon-btn"
        :class="{ on: mode === 'overview' }"
        @click="mode = 'overview'"
        :title="t('journal.overview')"
        :aria-label="t('journal.overview')"
      >
        <svg viewBox="0 0 24 24" width="19" height="19"><rect x="4" y="4" width="7" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="13" y="4" width="7" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="4" y="13" width="7" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="13" y="13" width="7" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>
      </button>
    </nav>

    <header>
      <h1>{{ journal.title }}</h1>
    </header>

    <div class="stage" :class="{ 'stage-flat': renderMode === '2d' }">
      <template v-if="renderMode === '3d'">
        <canvas ref="glCanvas" class="stage3d" v-show="glOk"></canvas>
        <EmptyState v-if="glFailed" class="webgl-error" :title="t('journal.webglError')">
          <template #icon>
            <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 3 20 7.5v9L12 21l-8-4.5v-9Z"/>
              <path d="M12 12 20 7.5M12 12 4 7.5M12 12v9"/>
            </svg>
          </template>
        </EmptyState>
      </template>
      <template v-else>
        <div v-if="mode === 'stack' && currentPage" class="flat-page-wrap">
          <div class="flat-frame">
            <button class="flat-page" @click="openFlatPage(currentPage.id)" @pointerdown="press.press(currentPage.id, $event)" @pointermove="press.move" @pointerup="press.cancel" @pointercancel="press.cancel" @pointerleave="press.cancel" :aria-label="t('journal.openPage')" :title="t('journal.openPage')">
              <PagePreview :key="currentPage.id" :page="currentPage" :width="1400" />
            </button>
          </div>
        </div>
        <div v-else-if="mode === 'overview'" class="flat-grid">
          <div v-for="(p, i) in journal.pages" :key="p.id" class="flat-thumb" :class="{ on: i === pageIdx }">
            <button class="flat-thumb-open" @click="openFlatPage(p.id)" @pointerdown="press.press(p.id, $event)" @pointermove="press.move" @pointerup="press.cancel" @pointercancel="press.cancel" @pointerleave="press.cancel" :aria-label="t('journal.openPage')" :title="t('journal.openPage')">
              <PagePreview :page="p" :width="520" />
            </button>
            <span class="flat-thumb-num">{{ i + 1 }}</span>
          </div>
        </div>
      </template>
      <p v-if="mode === 'stack'" class="page-pos">
        <span class="page-number">{{ pageIdx + 1 }} / {{ journal.pages.length }}</span>
      </p>
      <template v-if="mode === 'stack'">
        <button
          class="flip prev"
          :disabled="!canTurnStack(-1, pageIdx, journal.pages.length)"
          :aria-label="t('journal.previousPage')"
          :title="t('journal.previousPage')"
          @click="flip(-1)"
        >‹</button>
        <button
          class="flip next"
          :disabled="!canTurnStack(1, pageIdx, journal.pages.length)"
          :aria-label="t('journal.nextPage')"
          :title="t('journal.nextPage')"
          @click="flip(1)"
        >›</button>
      </template>
    </div>

    <footer>
      <button class="round" @click="addPage" :title="t('journal.newPage')">
        <svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 5 L12 19 M5 12 L19 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
    </footer>
    <MobileSlider
      :open="pageMenuTarget !== null"
      :title="t('journal.pageActions')"
      size="sm"
      @update:open="pageMenuTarget = null"
    >
      <div class="page-actions">
        <button
          v-if="!lastPage"
          class="page-action danger"
          @click="pageMenuTarget && requestDeletePage(pageMenuTarget)"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 6.5h15M9.2 6.5l.5-2h4.6l.5 2M6.5 6.5l.9 13h9.2l.9-13M10 10v6m4-6v6" /></svg>
          {{ t('journal.deletePage') }}
        </button>
      </div>
    </MobileSlider>
    <ConfirmDialog
      :open="deleteTarget !== null"
      :title="t('dlg.deletePageTitle')"
      :message="t('dlg.deletePageMessage')"
      @confirm="confirmDeletion"
      @cancel="deleteTarget = null"
    />
  </div>
</template>

<style scoped>
.journal-view {
  position: relative;
  isolation: isolate;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: var(--paper-text);
  background: var(--journal-shell);
}
.back {
  position: absolute;
  top: calc(20px + var(--safe-top));
  left: 26px;
  height: 34px;
  display: flex;
  align-items: center;
  color: var(--paper-muted);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: .01em;
  z-index: 10;
}
@media (hover: hover) {
  .back:hover { color: var(--paper-text); }
}
.view-modes {
  position: absolute;
  top: calc(20px + var(--safe-top));
  left: 150px;
  display: flex;
  gap: 4px;
  z-index: 10;
}
.icon-btn {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  color: var(--paper-muted);
  font-size: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
}
@media (hover: hover) {
  .icon-btn:hover { color: var(--paper-text); background: var(--paper-hover); }
}
.icon-btn.on { color: var(--paper-text); background: var(--paper-hover); }
header {
  position: relative;
  z-index: 10;
  padding: calc(31px + var(--safe-top)) 0 4px;
  text-align: center;
  pointer-events: none;
}
h1 {
  color: var(--paper-text);
  font-size: clamp(22px, 2vw, 28px);
  font-weight: 650;
  letter-spacing: -.035em;
}
/* The stage is full-bleed: the canvas runs under the header/footer chrome
   so the journal is never clipped by a footer edge — it reads as the whole
   screen, with buttons floating over it. */
.stage {
  position: absolute;
  inset: 0;
  display: flex;
}
.stage3d {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  touch-action: none;
}
/* The flat sheet is centred inside this padded box, so the flip arrows follow
   the sheet centre instead of the raw stage middle — otherwise asymmetric
   paddings (room for the header on top, the tray below) leave them floating
   above the page. */
.stage-flat {
  padding: 0;
  --flat-pad-top: calc(94px + var(--safe-top));
  --flat-pad-bottom: calc(96px + var(--safe-bottom));
}
.stage-flat .flip {
  top: calc(50% + (var(--flat-pad-top) - var(--flat-pad-bottom)) * 0.5);
}
.flat-page-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  padding: var(--flat-pad-top) 26px var(--flat-pad-bottom);
}
.flat-frame {
  position: relative;
  width: min(
    100%,
    calc((100vh - var(--flat-pad-top) - var(--flat-pad-bottom)) * 1.579),
    1080px
  );
}
.flat-page {
  display: block;
  width: 100%;
  padding: 0;
  border-radius: 4px;
  overflow: hidden;
  background: #fffefa;
  box-shadow: 0 24px 60px rgba(32,33,31,.24), 0 4px 10px rgba(32,33,31,.14);
}
.flat-grid {
  width: 100%;
  height: 100%;
  overflow-y: auto;
  overscroll-behavior: contain;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
  justify-items: center;
  align-content: start;
  gap: 20px 18px;
  padding: calc(132px + var(--safe-top)) 26px calc(100px + var(--safe-bottom));
}
.flat-thumb {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  max-width: 132px;
  min-width: 0;
}
.flat-thumb-open {
  display: block;
  width: 100%;
  padding: 0;
  border-radius: 3px;
  overflow: hidden;
  background: #fffefa;
  box-shadow: 0 10px 24px rgba(32,33,31,.18);
}
.flat-thumb.on .flat-thumb-open {
  outline: 2px solid #2a8097;
  outline-offset: 2px;
}
.flat-thumb-num {
  margin-top: 8px;
  color: var(--paper-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.page-actions { display: grid; gap: 8px; }
.page-action {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 13px 16px;
  border-radius: 12px;
  background: var(--chrome-control-bg);
  color: var(--chrome-text);
  text-align: left;
  font-size: 14px;
  font-weight: 600;
}
.page-action svg {
  width: 19px;
  height: 19px;
  flex: 0 0 19px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.page-action.danger { color: #c45c52; }
.webgl-error {
  position: absolute;
  inset: 50% 24px auto;
  margin: 0;
  transform: translateY(-50%);
  color: var(--paper-text);
  pointer-events: none;
}
.flip {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: rgba(27,28,25,.88);
  color: #fff;
  font-size: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 5;
  box-shadow: 0 10px 24px rgba(35,35,31,.19);
  transition: transform .25s ease, background .2s ease, opacity .2s ease;
}
@media (hover: hover) {
  .flip:hover { background: #383934; transform: translateY(-50%) scale(1.06); }
}
.flip:disabled { opacity: 0.22; box-shadow: none; }
.flip.prev { left: 40px; }
.flip.next { right: 40px; }
.page-pos {
  position: absolute;
  bottom: calc(max(30px, var(--safe-bottom)) + 64px);
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 7px;
  white-space: nowrap;
  color: var(--paper-muted);
  font-size: 12px;
  z-index: 4;
}
footer {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 18px;
  padding: 20px 0 max(30px, var(--safe-bottom));
}
.page-size {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  height: 32px;
  border: none;
  border-radius: 16px;
  padding: 0 12px;
  background: rgba(25,26,24,.82);
  color: #fff;
  font-size: 12px;
  backdrop-filter: blur(6px);
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
@media (max-width: 600px) {
  .back { left: 10px; top: calc(10px + var(--safe-top)); min-height: 44px; padding: 0 8px; }
  .icon-btn { width: 44px; height: 44px; }
  header { padding-top: calc(54px + var(--safe-top)); }
  h1 { font-size: clamp(20px, 6vw, 25px); }
  /* Keep the mode switch in the top chrome row with the back button — below
     the title it hovered over the first row of pages and pushed the grid down. */
  .view-modes {
    left: auto;
    right: 8px;
    top: calc(10px + var(--safe-top));
    transform: none;
  }
  .stage-flat {
    --flat-pad-top: calc(104px + var(--safe-top));
    --flat-pad-bottom: calc(92px + var(--safe-bottom));
  }
  .flip { width: 48px; height: 48px; }
  .flip.prev { left: 8px; }
  .flip.next { right: 8px; }
  .flat-page-wrap { padding: var(--flat-pad-top) 16px var(--flat-pad-bottom); }
  .flat-frame { width: 100%; }
  .flat-grid {
    grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
    gap: 18px 12px;
    padding: calc(104px + var(--safe-top)) 16px calc(92px + var(--safe-bottom));
  }
  .flat-thumb { max-width: 118px; }
  footer {
    gap: 14px;
    padding: 12px 0 max(24px, var(--safe-bottom));
  }
}
</style>
