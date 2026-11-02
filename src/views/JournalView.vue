<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  store, currentJournal, addPage, deletePage, openPage, closeToShelf,
  renameJournal, deleteJournal, journalToJson,
} from '../store'
import { useI18n } from 'vue-i18n'
import { initInk } from '../ink/engine'
import { usePrompt } from '../composables/usePrompt'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import { saveFile } from '../saveFile'
import type { JournalScene } from '../three/journalScene'
import { canTurnStack } from '../three/layout'

const { t } = useI18n()
const { prompt } = usePrompt()
const journal = computed(() => currentJournal())
const deleteTarget = ref<{ type: 'page' | 'journal'; id: string } | null>(null)
const mode = computed({
  get: () => store.journalMode,
  set: (value) => { store.journalMode = value },
})
const pageIdx = computed({
  get: () => store.journalPageIdx,
  set: (value) => { store.journalPageIdx = value },
})
const menuOn = ref(false)
const glCanvas = ref<HTMLCanvasElement>()
const glOk = ref(false)
const glFailed = ref(false)
const glHover = ref<{ id: string; x: number; y: number } | null>(null)
const glDels = ref<{ id: string; x: number; y: number }[]>([])
const coarse = typeof matchMedia === 'function' && matchMedia('(hover: none)').matches
let scene: JournalScene | null = null
let sceneRequest = 0

function requestDeletePage(id: string, ev: Event) {
  ev.stopPropagation()
  deleteTarget.value = { type: 'page', id }
}

function requestDeleteJournal() {
  if (!journal.value) return
  menuOn.value = false
  deleteTarget.value = { type: 'journal', id: journal.value.id }
}

function confirmDeletion() {
  const target = deleteTarget.value
  if (!target) return
  if (target.type === 'page') {
    deletePage(target.id)
  } else {
    deleteJournal(target.id)
    closeToShelf()
  }
  deleteTarget.value = null
}

function flip(dir: 1 | -1) {
  if (scene) {
    if (scene.busy) return
    scene.flip(dir) // pageIdx syncs via onFlipDone
    return
  }
  const total = journal.value?.pages.length ?? 0
  if (canTurnStack(dir, pageIdx.value, total)) pageIdx.value += dir
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
      onHoverPage: (id, anchor) => {
        glHover.value = id && anchor ? { id, x: anchor.x, y: anchor.y } : null
      },
      onSheetAnchors: (list) => { glDels.value = list },
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
    s.ready.then(() => { if (scene === s) glOk.value = true })
  } catch {
    scene = null
    if (request === sceneRequest && canvas.isConnected) glFailed.value = true
  }
}

function stopScene() {
  sceneRequest++
  scene?.dispose()
  scene = null
  glOk.value = false
  glHover.value = null
  glDels.value = []
}

onMounted(startScene)
onBeforeUnmount(stopScene)

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

async function rename() {
  menuOn.value = false
  const j = journal.value
  if (!j) return
  const title = await prompt({
    title: t('shelf.rename'),
    value: j.title,
    placeholder: t('shelf.renamePrompt'),
  })
  if (title) renameJournal(j.id, title)
}

function exportJournal() {
  const j = journal.value
  const json = j && journalToJson(j.id)
  if (!json) return
  saveFile(`${j!.title}.paper.json`, new Blob([json], { type: 'application/json' }))
  menuOn.value = false
}

async function goToPage() {
  const j = journal.value
  if (!j) return
  const raw = await prompt({
    title: t('journal.goto'),
    value: String(pageIdx.value + 1),
    placeholder: t('journal.gotoPrompt'),
    inputMode: 'numeric',
    confirmText: t('journal.goto'),
  })
  const n = Number(raw)
  if (!raw || !Number.isInteger(n) || n < 1 || n > j.pages.length) return
  if (mode.value === 'stack') pageIdx.value = n - 1
  const id = j.pages[n - 1].id
  openPage(id)
}
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

    <nav class="right-actions">
      <button class="icon-btn" @click="goToPage" :title="t('journal.goto')">
        <svg viewBox="0 0 24 24" width="19" height="19"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15.5 15.5 L21 21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
      <button class="icon-btn" @click="menuOn = !menuOn" :title="t('shelf.menu')">⋯</button>
    </nav>

    <div v-if="menuOn" class="menu-shield" @click="menuOn = false" />
    <div v-if="menuOn" class="menu-pop">
      <button class="menu-item" @click="rename">
        <svg aria-hidden="true" viewBox="0 0 20 20" width="16" height="16">
          <path d="m12.8 3.2 4 4M3.5 16.5l3.8-.8L16 7a1.8 1.8 0 0 0-2.5-2.5l-8.7 8.7-.8 3.3Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        {{ t('shelf.rename') }}
      </button>
      <button class="menu-item" @click="exportJournal">
        <svg aria-hidden="true" viewBox="0 0 20 20" width="16" height="16">
          <path d="M5 2.8h6l4 4v4.5M11 2.8v4h4M5 2.8v14.4h5M12 14v-5m-2 3 2-2 2 2M11 17.2h5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        {{ t('shelf.export') }}
      </button>
      <button class="menu-item danger" @click="requestDeleteJournal">
        <svg aria-hidden="true" viewBox="0 0 20 20" width="16" height="16">
          <path d="M3.5 5.5h13M8 5.5V3.2h4v2.3m3.2 0-.7 11.2H5.5L4.8 5.5m3.2 3v5.2m4-5.2v5.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        {{ t('shelf.delete') }}
      </button>
    </div>

    <header>
      <h1>{{ journal.title }}</h1>
      <p class="count">
        <svg class="ink" viewBox="0 0 12 14" width="11" height="13"><path d="M6 0.5 C6 0.5 1 6.5 1 9.5 a5 5 0 0 0 10 0 C11 6.5 6 0.5 6 0.5 Z" fill="currentColor"/></svg>
        {{ t('journal.count', journal.pages.length) }}
      </p>
    </header>

    <div class="stage">
      <canvas ref="glCanvas" class="stage3d" v-show="glOk"></canvas>
      <p v-if="mode === 'stack'" class="page-pos">
        {{ pageIdx + 1 }} / {{ journal.pages.length }}
      </p>
      <button
        v-if="glOk && glHover && !coarse"
        class="del gl-del"
        :style="{ left: `${glHover.x}px`, top: `${glHover.y}px` }"
        :aria-label="t('dlg.deletePageTitle')"
        :title="t('dlg.deletePageTitle')"
        @click="requestDeletePage(glHover.id, $event)"
      >
        ×
      </button>
      <template v-if="glOk && coarse">
        <button
          v-for="d in glDels"
          :key="d.id"
          class="del gl-del"
          :style="{ left: `${d.x}px`, top: `${d.y}px` }"
          :aria-label="t('dlg.deletePageTitle')"
          :title="t('dlg.deletePageTitle')"
          @click="requestDeletePage(d.id, $event)"
        >
          ×
        </button>
      </template>
      <p v-if="glFailed" class="webgl-error" role="status">{{ t('journal.webglError') }}</p>
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
        <svg viewBox="0 0 24 24" width="22" height="22"><path d="M12 5 L12 19 M5 12 L19 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
    </footer>
    <ConfirmDialog
      :open="deleteTarget !== null"
      :title="deleteTarget?.type === 'page' ? t('dlg.deletePageTitle') : t('dlg.deleteJournalTitle')"
      :message="deleteTarget?.type === 'page'
        ? t('dlg.deletePageMessage')
        : t('dlg.deleteJournalMessage', { title: journal.title })"
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
  background: radial-gradient(ellipse at 48% 42%, #efefec 0%, #d5d6d2 58%, #b9bbb6 100%);
}
.back {
  position: absolute;
  top: 20px;
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
  top: 20px;
  left: 150px;
  display: flex;
  gap: 4px;
  z-index: 10;
}
.right-actions {
  position: absolute;
  top: 20px;
  right: 26px;
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
.menu-shield {
  position: fixed;
  inset: 0;
  z-index: 39;
}
.menu-pop {
  position: absolute;
  top: 56px;
  right: 26px;
  background: var(--chrome-bg);
  color: var(--chrome-text);
  border: 1px solid var(--chrome-border);
  border-radius: 10px;
  padding: 6px;
  z-index: 40;
  box-shadow: var(--chrome-shadow);
}
.menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 16px;
  color: var(--chrome-text);
  border-radius: 7px;
  text-align: left;
  font-size: 14px;
  white-space: nowrap;
}
.menu-item svg { flex: 0 0 16px; }
@media (hover: hover) {
  .menu-item:hover { background: var(--chrome-hover); }
}
.menu-item.danger { color: #e07070; }
header {
  padding: 31px 0 4px;
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
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
}
.count .ink { display: inline-block; }
.stage {
  flex: 1;
  position: relative;
  min-height: 0;
  display: flex;
}
.stage3d {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  touch-action: none;
}
.gl-del {
  position: absolute;
  transform: translate(-50%, -50%);
  opacity: 1;
  z-index: 20;
}
.del {
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(255, 255, 255, .35);
  border-radius: 50%;
  color: #fff;
  background: #393a36;
  box-shadow: 0 3px 10px rgba(0, 0, 0, .28);
  font-size: 17px;
  line-height: 1;
}
.del:active { transform: translate(-50%, -50%) scale(.94); }
.webgl-error {
  position: absolute;
  inset: 50% 24px auto;
  margin: 0;
  transform: translateY(-50%);
  color: var(--paper-muted);
  text-align: center;
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
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
  color: var(--paper-muted);
  font-size: 12px;
  z-index: 4;
}
footer {
  display: flex;
  justify-content: center;
  gap: 18px;
  padding: 20px 0 max(30px, env(safe-area-inset-bottom));
}
.round {
  width: 48px;
  height: 48px;
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
  .back { left: 10px; top: 10px; min-height: 44px; padding: 0 8px; }
  .right-actions { right: 8px; top: 10px; }
  .icon-btn { width: 44px; height: 44px; }
  header { padding-top: 54px; }
  h1 { font-size: clamp(20px, 6vw, 25px); }
  .view-modes {
    left: 50%;
    top: 112px;
    transform: translateX(-50%);
  }
  .flip { width: 48px; height: 48px; }
  .flip.prev { left: 8px; }
  .flip.next { right: 8px; }
  footer {
    gap: 14px;
    padding: 12px 0 max(14px, env(safe-area-inset-bottom));
  }
}
</style>
