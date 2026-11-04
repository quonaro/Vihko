<script setup lang="ts">
import { ref } from 'vue'
import { store } from '../store'
import { INK_TOOLS } from '../ink/tools'
import ColorPicker from './ColorPicker.vue'
import ShapeMenu from './ShapeMenu.vue'
import BrushPanel from './BrushPanel.vue'
import FilterPanel from './FilterPanel.vue'
import type { ToolId } from '../types'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const emit = defineEmits<{ photo: [file: File] }>()

const tools: { id: ToolId }[] = [
  { id: 'eraser' },
  { id: 'draw' },
  { id: 'sketch' },
  { id: 'outline' },
  { id: 'write' },
  { id: 'color' },
  { id: 'shapes' },
  { id: 'fill' },
  { id: 'cut' },
  { id: 'filter' },
  { id: 'transform' },
]

const fileInput = ref<HTMLInputElement>()
const pickerOpen = ref(false)
const shapeMenuOpen = ref(false)

const brushPanelOpen = ref(false)
const filterPanelOpen = ref(false)

function selectTool(id: ToolId) {
  if (id === 'filter') {
    filterPanelOpen.value = store.tool === 'filter' ? !filterPanelOpen.value : true
    store.tool = 'filter'
    brushPanelOpen.value = false
    shapeMenuOpen.value = false
    return
  }
  filterPanelOpen.value = false
  // Second tap on the active fill tool cycles bucket → inverse → bg-removal.
  if (store.tool === id && id === 'fill') {
    const modes = ['normal', 'invert', 'erase'] as const
    store.fillMode = modes[(modes.indexOf(store.fillMode) + 1) % modes.length]
    return
  }
  // Second tap on the active ink tool opens its brush settings.
  if (store.tool === id && INK_TOOLS.includes(id)) {
    brushPanelOpen.value = !brushPanelOpen.value
    shapeMenuOpen.value = false
    return
  }
  brushPanelOpen.value = false
  store.tool = id
  if (id === 'shapes') shapeMenuOpen.value = !shapeMenuOpen.value
  else shapeMenuOpen.value = false
}

function pickPhoto() {
  fileInput.value?.click()
}

function onPhotoPicked(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) emit('photo', file)
  input.value = ''
}
</script>

<template>
  <div class="tray">
    <div class="tools">
      <button class="action icon" @click="pickPhoto" :title="t('canvas.photo')">
        <svg viewBox="0 0 24 40" width="26" height="44">
          <rect x="3" y="12" width="18" height="16" rx="2" fill="#55565c" />
          <rect x="5" y="14" width="14" height="12" rx="1" fill="#333" />
          <circle cx="9" cy="18" r="2" fill="#d9a441" />
          <path d="M5 24 L9 20 L12 23 L15 19 L19 24 Z" fill="#8a8a8e" />
        </svg>
      </button>
      <button
        v-for="tool in tools"
        :key="tool.id"
        class="tool"
        :class="{ active: store.tool === tool.id }"
        :title="tool.id === 'fill' ? t(`tool.fillMode.${store.fillMode}`) : t(`tool.${tool.id}`)"
        :aria-expanded="tool.id === 'shapes' ? shapeMenuOpen : undefined"
        @click="selectTool(tool.id)"
      >
        <svg viewBox="0 0 24 40" width="26" height="44">
          <!-- eraser -->
          <g v-if="tool.id === 'eraser'">
            <rect x="5" y="10" width="14" height="22" rx="3" fill="#8a8a8e" />
            <rect x="5" y="10" width="14" height="8" rx="3" fill="#b8b8bc" />
          </g>
          <!-- fountain pen (draw) -->
          <g v-else-if="tool.id === 'draw'">
            <path d="M12 4 L17 14 L15 30 L9 30 L7 14 Z" fill="#d9a441" />
            <circle cx="12" cy="18" r="1.6" fill="#333" />
            <path d="M12 18 L12 28" stroke="#333" stroke-width="1.2" />
          </g>
          <!-- pencil (sketch) -->
          <g v-else-if="tool.id === 'sketch'">
            <path d="M12 4 L16.5 15 L7.5 15 Z" fill="#c98a4b" />
            <path d="M12 4 L13.8 8 L10.2 8 Z" fill="#333" />
            <rect x="7.5" y="15" width="9" height="19" fill="#e0a35a" />
          </g>
          <!-- marker (outline) -->
          <g v-else-if="tool.id === 'outline'">
            <path d="M8 6 L16 6 L16 20 L8 20 Z" fill="#55565c" />
            <path d="M8 20 L16 20 L14.5 26 L9.5 26 Z" fill="#333" />
            <rect x="9" y="26" width="6" height="8" rx="1" fill="#222" />
          </g>
          <!-- ink pen (write) -->
          <g v-else-if="tool.id === 'write'">
            <rect x="10" y="4" width="4" height="20" rx="2" fill="#a0724a" />
            <path d="M10 24 L14 24 L12 31 Z" fill="#666" />
          </g>
          <!-- watercolor brush (color) -->
          <g v-else-if="tool.id === 'color'">
            <path d="M12 4 C15 8 16 12 14 16 L10 16 C8 12 9 8 12 4 Z" fill="#9a7bb8" />
            <rect x="10.5" y="16" width="3" height="16" rx="1.5" fill="#666" />
          </g>
          <!-- geometric shapes -->
          <g v-else-if="tool.id === 'shapes'" fill="none" stroke="#2a8097" stroke-width="1.8" stroke-linejoin="round">
            <rect x="4" y="8" width="16" height="22" rx="1" />
            <path d="M5 29 19 9" />
          </g>
          <!-- fill roller (fill) -->
          <g v-else-if="tool.id === 'fill'">
            <rect x="4" y="6" width="12" height="7" rx="3" fill="#8a8a8e" />
            <path d="M16 9.5 L20 9.5 L20 15 L12 15" fill="none" stroke="#b8b8bc" stroke-width="1.6" />
            <rect x="10.5" y="15" width="3" height="14" rx="1.5" fill="#666" />
            <g v-if="store.fillMode !== 'normal'">
              <circle cx="20" cy="5" r="4.5" :fill="store.fillMode === 'invert' ? '#2a8097' : '#c45a4a'" />
              <text x="20" y="8" text-anchor="middle" font-size="7" fill="#fff" font-family="sans-serif">
                {{ store.fillMode === 'invert' ? '↺' : '✕' }}
              </text>
            </g>
          </g>
          <!-- scissors (cut) -->
          <g v-else-if="tool.id === 'cut'">
            <circle cx="7" cy="26" r="4" fill="none" stroke="#9a9aa0" stroke-width="2" />
            <circle cx="17" cy="26" r="4" fill="none" stroke="#9a9aa0" stroke-width="2" />
            <path d="M9.5 23 L19 6 M14.5 23 L5 6" stroke="#c8c8cc" stroke-width="2" stroke-linecap="round" />
          </g>
          <!-- magic wand / adjust (filter) -->
          <g v-else-if="tool.id === 'filter'" fill="none" stroke="#9a9aa0" stroke-width="1.7" stroke-linecap="round">
            <path d="M8 30 L17 12" stroke-width="3" />
            <path d="M17 8 l1.4 3 3 1.4 -3 1.4 -1.4 3 -1.4 -3 -3 -1.4 3 -1.4 Z" fill="#c8a2e8" stroke="none" />
            <path d="M6 9 l.8 1.8 1.8.8 -1.8.8 -.8 1.8 -.8 -1.8 -1.8 -.8 1.8 -.8 Z" fill="#c8a2e8" stroke="none" />
          </g>
          <g v-else-if="tool.id === 'transform'" fill="none" stroke="#9a9aa0" stroke-width="1.5" stroke-linejoin="round">
            <rect x="5" y="10" width="14" height="18" rx="1" />
            <path d="M5 15V10h5M19 23v5h-5" />
            <path d="M12 5v4 M10 7l2-2 2 2 M12 34v-4 M10 32l2 2 2-2" />
          </g>
        </svg>
      </button>
    </div>

    <ShapeMenu v-model:open="shapeMenuOpen" />

    <button
      class="swatch"
      :style="{ background: `radial-gradient(circle at 34% 30%, rgba(255,255,255,.35), rgba(255,255,255,0) 42%), ${store.color}` }"
      :title="t('picker.hint')"
      @click="pickerOpen = true"
    />
    <ColorPicker v-model:open="pickerOpen" />

    <BrushPanel v-model:open="brushPanelOpen" />

    <FilterPanel v-model:open="filterPanelOpen" />

    <input
      ref="fileInput"
      type="file"
      accept="image/*"
      hidden
      @change="onPhotoPicked"
    />

  </div>
</template>

<style scoped>
.tray {
  position: absolute;
  left: 0; right: 0; bottom: 0;
  height: var(--tray-height, 60px);
  background: linear-gradient(180deg, color-mix(in srgb, var(--chrome-bg) 90%, white 10%), var(--chrome-bg));
  border-top: 1px solid var(--chrome-border);
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 0 18px;
  z-index: 30;
  animation: tray-up 0.32s cubic-bezier(0.2, 0.85, 0.3, 1) 0.08s backwards;
  overflow-x: auto;
  scrollbar-width: none;
  touch-action: pan-x;
}
.tray::-webkit-scrollbar { display: none; }
.tray > * { flex-shrink: 0; }
.action {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  color: var(--chrome-text);
  font-size: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.75;
  flex-shrink: 0;
}
@media (hover: hover) {
  .action:hover { opacity: 1; background: var(--chrome-hover); }
}
.action.icon { margin-bottom: 11px; }
.action.icon svg { display: block; }
.tools {
  display: flex;
  gap: 4px;
  align-items: flex-end;
  justify-content: center;
  flex: 1 0 auto;
  height: 100%;
}
.tool {
  height: 100%;
  padding: 0 8px 8px;
  display: flex;
  align-items: flex-end;
  opacity: 0.75;
  border-top: 3px solid transparent;
  transition: opacity 0.15s, border-color 0.15s;
}
.tool svg { transition: transform 0.15s; }
@media (hover: hover) {
  .tool:hover { opacity: 1; }
}
.tool.active {
  opacity: 1;
  border-top-color: #2a8097;
}
.tool.active svg { transform: translateY(-6px); }
.swatch {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.22);
  box-shadow: inset 0 0 8px rgba(0, 0, 0, 0.25), 0 2px 6px rgba(0,0,0,0.4);
  cursor: pointer;
  flex: 0 0 auto;
}
</style>
