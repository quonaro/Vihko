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
import { setLocale } from '../i18n'
import { setTheme, theme } from '../theme'
import {
  appVersion,
  update,
  checkForUpdate,
  downloadUpdate,
  perms,
  permsRelevant,
  refreshPermissions,
  grantNotificationPermission,
  grantInstallPermission,
} from '../update'
import { morphTo, centeredRect } from '../anim'
import { presetCovers } from '../covers'
import { imageFileToPhoto } from '../ink/ops'
import MobileSlider from '../components/MobileSlider.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import EmptyState from '../components/EmptyState.vue'
import { usePrompt } from '../composables/usePrompt'
import { saveFile } from '../saveFile'
import { COVER_TEXTURES, type CoverTexture } from '../types'
import type { ShelfAnchor, ShelfJournal, ShelfScene } from '../three/shelfScene'

const { t, locale } = useI18n()
const { prompt } = usePrompt()
const deleteTarget = ref<string | null>(null)
const menuJournalId = ref<string | null>(null)
const menuOn = ref(false)
const query = ref('')
const searchOn = ref(false)
const coverOn = ref(false)
const coverTextureOn = ref(false)
const settingsOn = ref(false)
const coverInput = ref<HTMLInputElement>()

const menuJournal = computed(() => store.journals.find((j) => j.id === menuJournalId.value) ?? null)
const coverTextures = COVER_TEXTURES
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
const results = computed(() => {
  const q = query.value.trim().toLowerCase()
  return q ? store.journals.filter((j) => j.title.toLowerCase().includes(q)) : store.journals
})

function openSearch() {
  query.value = ''
  searchOn.value = true
}

// --- Permissions (Android) ---------------------------------------------------

const showPerms = permsRelevant()

// Re-read states when the sheet opens and when the user returns from a system
// settings screen (e.g. after toggling "install unknown apps").
function onVisible() {
  if (!document.hidden) void refreshPermissions()
}
watch(settingsOn, (on) => {
  if (!showPerms) return
  if (on) {
    void refreshPermissions()
    document.addEventListener('visibilitychange', onVisible)
  } else {
    document.removeEventListener('visibilitychange', onVisible)
  }
})
onBeforeUnmount(() => document.removeEventListener('visibilitychange', onVisible))

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
      borderRadius: '4.5%',
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
function openJournalMenu(id: string) {
  menuJournalId.value = id
  menuOn.value = true
}

function requestDelete(id: string, ev: Event) {
  ev.stopPropagation()
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

async function onCoverPicked(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  const img = await imageFileToPhoto(file, 800)
  applyCover(img.src)
}
</script>

<template>
  <div class="shelf">
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
        <svg viewBox="0 0 24 24" width="22" height="22"><path d="M12 5 L12 19 M5 12 L19 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
    </footer>

    <MobileSlider v-model:open="menuOn" :title="menuJournal?.title ?? t('shelf.menu')" size="sm">
      <div class="journal-actions">
        <button class="journal-action" @click="rename">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20l.8-3.8L16 5l3 3L7.8 19.2 4 20zM14 7l3 3" /></svg>
          {{ t('shelf.rename') }}
        </button>
        <button class="journal-action" @click="exportJournal">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m-4.5-4.5L12 15l4.5-4.5M5.5 19h13" /></svg>
          {{ t('shelf.export') }}
        </button>
        <button class="journal-action" @click="openCoverPicker">
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4.5" y="5" width="15" height="14" rx="2" /><circle cx="9.5" cy="10" r="1.5" /><path d="m5.5 16.5 5-5 3.5 3.5 2.5-2.5 2.5 2.5" /></svg>
          {{ t('shelf.cover') }}
        </button>
        <button class="journal-action" @click="openCoverTexturePicker">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7.5h16M4 12h16M4 16.5h16" /><circle cx="8" cy="7.5" r="1.5" /><circle cx="15" cy="12" r="1.5" /><circle cx="10" cy="16.5" r="1.5" /></svg>
          {{ t('shelf.coverTexture') }}
        </button>
        <button
          class="journal-action danger"
          @click="menuJournal && requestDelete(menuJournal.id, $event)"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 6.5h15M9.2 6.5l.5-2h4.6l.5 2M6.5 6.5l.9 13h9.2l.9-13M10 10v6m4-6v6" /></svg>
          {{ t('shelf.delete') }}
        </button>
      </div>
    </MobileSlider>

    <MobileSlider v-model:open="coverTextureOn" :title="t('shelf.coverTexture')" size="sm">
      <p class="hint texture-hint">{{ menuJournal?.title }}</p>
      <div class="texture-options" role="group" :aria-label="t('shelf.coverTexture')">
        <button
          v-for="texture in coverTextures"
          :key="texture"
          class="texture-option"
          :class="[
            `texture-${texture}`,
            { selected: (menuJournal?.coverTexture ?? 'paper') === texture },
          ]"
          :aria-pressed="(menuJournal?.coverTexture ?? 'paper') === texture"
          @click="applyCoverTexture(texture)"
        >
          <span class="texture-swatch" aria-hidden="true"></span>
          <span class="texture-copy">
            <span class="texture-name">{{ t(`shelf.texture.${texture}.title`) }}</span>
            <span class="texture-description">{{ t(`shelf.texture.${texture}.hint`) }}</span>
          </span>
          <svg
            v-if="(menuJournal?.coverTexture ?? 'paper') === texture"
            class="texture-check"
            viewBox="0 0 20 20"
            width="20"
            height="20"
            aria-hidden="true"
          >
            <path d="m4 10 4 4 8-8" />
          </svg>
        </button>
      </div>
    </MobileSlider>

    <MobileSlider v-model:open="coverOn" :title="t('shelf.cover')" no-scrollbar>
      <p class="hint cover-hint">{{ menuJournal?.title }}</p>
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
        <button
          v-if="menuJournal?.coverImg"
          class="cover-option plain remove-cover"
          :aria-label="t('shelf.removeCover')"
          :title="t('shelf.removeCover')"
          @click="applyCover(null)"
        >
          <svg
            viewBox="0 0 24 24"
            width="24"
            height="24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <rect x="3.5" y="5" width="17" height="14" rx="2" />
            <circle cx="9" cy="10" r="1.5" />
            <path d="m5 17 5-5 3 3 2-2 4 4M4 4l16 16" />
          </svg>
        </button>
      </div>
      <input ref="coverInput" type="file" accept="image/*" hidden @change="onCoverPicked" />
    </MobileSlider>

    <MobileSlider v-model:open="settingsOn" :title="t('shelf.settings')" size="sm">
      <div class="set-row">
        <span class="set-label">{{ t('shelf.version') }}</span>
        <span class="set-value">v{{ appVersion }}</span>
      </div>
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
      <div class="set-row">
        <span class="set-label">{{ t('shelf.language') }}</span>
        <div class="seg">
          <button class="seg-btn" :class="{ on: locale === 'en' }" @click="setLocale('en')">English</button>
          <button class="seg-btn" :class="{ on: locale === 'ru' }" @click="setLocale('ru')">Русский</button>
        </div>
      </div>
      <div class="set-row">
        <span class="set-label">{{ t('shelf.updates') }}</span>
        <button
          class="set-action"
          :class="{ accent: update.status === 'available' }"
          :disabled="update.busy || update.dl === 'downloading'"
          @click="update.status === 'available' ? downloadUpdate() : checkForUpdate()"
        >{{ update.busy ? t('shelf.checking')
          : update.status === 'available'
            ? (update.dl === 'idle' ? t('shelf.updateNow', { v: update.latest }) : updateLabel)
            : update.status === 'error' ? t('shelf.checkFailed')
            : t('shelf.checkUpdate') }}</button>
      </div>
      <template v-if="showPerms">
        <div class="set-row">
          <span class="set-label">{{ t('shelf.permNotif') }}</span>
          <span v-if="perms.notifications === 'granted'" class="set-value">{{ t('shelf.permGranted') }}</span>
          <button v-else class="set-action" @click="grantNotificationPermission()">{{
            perms.notifications === 'denied' ? t('shelf.permOpenSettings') : t('shelf.permGrant')
          }}</button>
        </div>
        <div class="set-row">
          <span class="set-label">{{ t('shelf.permInstall') }}</span>
          <span v-if="perms.install === 'granted'" class="set-value">{{ t('shelf.permGranted') }}</span>
          <button v-else class="set-action" @click="grantInstallPermission()">{{ t('shelf.permOpenSettings') }}</button>
        </div>
      </template>
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
        <EmptyState v-if="!results.length" class="search-none" :title="t('shelf.noMatch')">
          <template #icon>
            <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
              <circle cx="10.5" cy="10.5" r="6.5"/>
              <path d="M15.5 15.5 20 20"/>
            </svg>
          </template>
        </EmptyState>
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
.search-input:focus { border-color: #2a8097; }
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
  box-shadow: inset 0 0 0 1px var(--chrome-border);
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
.search-none { padding: 18px 0 10px; }
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

.journal-actions { display: grid; gap: 8px; }
.journal-action {
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
.journal-action svg {
  width: 19px;
  height: 19px;
  flex: 0 0 19px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.journal-action.danger { color: #c45c52; }

.texture-hint { margin: -4px 0 14px; }
.texture-options { display: grid; gap: 8px; }
.texture-option {
  min-height: 72px;
  display: flex;
  align-items: center;
  gap: 13px;
  padding: 9px 12px;
  border: 1px solid var(--chrome-border);
  border-radius: 12px;
  color: var(--chrome-text);
  text-align: left;
  background: transparent;
  transition: background .16s ease, border-color .16s ease;
}
.texture-option.selected {
  border-color: var(--chrome-text);
  background: var(--chrome-hover);
}
.texture-swatch {
  width: 40px;
  height: 50px;
  flex: 0 0 40px;
  border: 1px solid rgba(30, 27, 24, .18);
  border-radius: 5px;
  background-color: #b7a98e;
  box-shadow: 0 2px 4px rgba(0, 0, 0, .12);
}
.texture-smooth .texture-swatch { background-color: #718792; }
.texture-comic .texture-swatch {
  background-color: #dfb77e;
  background-image: radial-gradient(rgba(32, 28, 24, .62) 1px, transparent 1.25px);
  background-size: 5px 5px;
}
.texture-paper .texture-swatch {
  background-image:
    repeating-linear-gradient(12deg, rgba(255,255,255,.12) 0 1px, transparent 1px 4px),
    repeating-linear-gradient(103deg, rgba(48,39,30,.08) 0 1px, transparent 1px 5px);
}
.texture-copy { min-width: 0; flex: 1; display: grid; gap: 3px; }
.texture-name { font-size: 14px; font-weight: 600; }
.texture-description { color: var(--chrome-muted); font-size: 12px; }
.texture-check {
  flex: 0 0 20px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
@media (hover: hover) {
  .texture-option:hover { background: var(--chrome-hover); }
}

.cover-hint { margin: -4px 0 14px; }
.hint { color: var(--chrome-muted); font-size: 13px; }
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
.seg-btn.on { background: #2a8097; color: #fff; }
.set-value {
  color: var(--chrome-muted);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.set-action {
  padding: 7px 16px;
  border-radius: 8px;
  background: var(--chrome-control-bg);
  color: var(--chrome-text);
  font-size: 13px;
  font-weight: 650;
}
.set-action.accent {
  background: #2a8097;
  color: #fff;
}
.set-action:disabled { opacity: .6; }
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
  border: 1px solid var(--chrome-border);
  cursor: pointer;
  color: var(--chrome-muted);
  font-size: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 6px;
}
.cover-option.upload, .cover-option.plain {
  background: var(--chrome-input-bg);
}
@media (max-width: 600px) {
  .topbar { padding: 14px 16px 0; }
  header { padding-top: 18px; }
  footer { padding-bottom: max(24px, env(safe-area-inset-bottom)); }
}
</style>
