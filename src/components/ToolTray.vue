<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { store, palette, addPage, openPage, clearPage } from '../store'
import { mixColors } from '../ink/mix'
import ColorPicker from './ColorPicker.vue'
import type { ShapeKind, ToolId } from '../types'
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
  { id: 'move' },
  { id: 'transform' },
]

const fileInput = ref<HTMLInputElement>()
const pickerOpen = ref(false)
const shapeMenuOpen = ref(false)
const shapeMenu = ref<HTMLElement>()
const shapeOptions: ShapeKind[] = ['rectangle', 'ellipse', 'line', 'arrow', 'triangle', 'diamond']

function selectTool(id: ToolId) {
  store.tool = id
  if (id === 'shapes') shapeMenuOpen.value = !shapeMenuOpen.value
  else shapeMenuOpen.value = false
}

function chooseShape(shape: ShapeKind) {
  store.shape = shape
  store.tool = 'shapes'
  shapeMenuOpen.value = false
}

function closeShapeMenuOutside(e: PointerEvent) {
  const target = e.target
  if (
    target instanceof Element &&
    (target.closest('.shape-menu') || target.closest('.tool[aria-expanded]'))
  )
    return
  shapeMenuOpen.value = false
}

watch(shapeMenuOpen, async (open) => {
  if (open) {
    await nextTick()
    shapeMenu.value?.focus()
    document.addEventListener('pointerdown', closeShapeMenuOutside)
  } else {
    document.removeEventListener('pointerdown', closeShapeMenuOutside)
  }
})
onBeforeUnmount(() => document.removeEventListener('pointerdown', closeShapeMenuOutside))

function pickPhoto() {
  fileInput.value?.click()
}

function onPhotoPicked(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) emit('photo', file)
  input.value = ''
}

function newPage() {
  const p = addPage()
  if (p) openPage(p.id)
}

// Drag a palette dot onto the color swatch to blend it in (Paper-style mixing).
let dragColor: string | null = null
const ghost = ref<{ color: string; x: number; y: number } | null>(null)

function onDotDown(e: PointerEvent, color: string) {
  dragColor = color
  ghost.value = { color, x: e.clientX, y: e.clientY }
  ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
}

function onDotMove(e: PointerEvent) {
  if (ghost.value) ghost.value = { ...ghost.value, x: e.clientX, y: e.clientY }
}

function onDotUp(e: PointerEvent) {
  if (!dragColor) return
  const el = document.elementFromPoint(e.clientX, e.clientY)
  if (el?.classList.contains('swatch')) {
    store.color = mixColors(store.color, dragColor, 0.35)
  } else if (Math.abs(e.movementY) < 40) {
    store.color = dragColor // plain tap -> pick color
  }
  dragColor = null
  ghost.value = null
}

// A tray scroll gesture cancels the in-flight pointer — just drop the drag.
function onDotCancel() {
  dragColor = null
  ghost.value = null
}
</script>

<template>
  <div class="tray">
    <button class="action" @click="newPage" :title="t('canvas.newPage')">+</button>

    <div class="tools">
      <button
        v-for="tool in tools"
        :key="tool.id"
        class="tool"
        :class="{ active: store.tool === tool.id }"
        :title="t(`tool.${tool.id}`)"
        :aria-expanded="tool.id === 'shapes' ? shapeMenuOpen : undefined"
        @click="selectTool(tool.id)"
      >
        <svg viewBox="0 0 24 40" width="22" height="36">
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
          </g>
          <!-- scissors (cut) -->
          <g v-else-if="tool.id === 'cut'">
            <circle cx="7" cy="26" r="4" fill="none" stroke="#9a9aa0" stroke-width="2" />
            <circle cx="17" cy="26" r="4" fill="none" stroke="#9a9aa0" stroke-width="2" />
            <path d="M9.5 23 L19 6 M14.5 23 L5 6" stroke="#c8c8cc" stroke-width="2" stroke-linecap="round" />
          </g>
          <g v-else-if="tool.id === 'transform'" fill="none" stroke="#9a9aa0" stroke-width="1.5" stroke-linejoin="round">
            <rect x="5" y="10" width="14" height="18" rx="1" />
            <path d="M5 15V10h5M19 23v5h-5" />
            <path d="M12 5v4 M10 7l2-2 2 2 M12 34v-4 M10 32l2 2 2-2" />
          </g>
          <!-- move cross (move) -->
          <g v-else fill="none" stroke="#9a9aa0" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 5v30 M12 5l-3.5 3.5 M12 5l3.5 3.5 M12 35l-3.5-3.5 M12 35l3.5-3.5" />
            <path d="M3 20h18 M3 20l3.5-3.5 M3 20l3.5 3.5 M21 20l-3.5-3.5 M21 20l-3.5 3.5" />
          </g>
        </svg>
      </button>
    </div>

    <Teleport to="body">
      <div v-if="shapeMenuOpen">
        <div
          ref="shapeMenu"
          class="shape-menu"
          role="menu"
          tabindex="-1"
          :aria-label="t('shapeMenu.title')"
          @keydown.esc.stop.prevent="shapeMenuOpen = false"
        >
          <button
            v-for="shape in shapeOptions"
            :key="shape"
            class="shape-option"
            :class="{ selected: store.shape === shape }"
            role="menuitemradio"
            :aria-checked="store.shape === shape"
            :aria-label="t(`shapeMenu.${shape}`)"
            @click="chooseShape(shape)"
          >
            <svg viewBox="0 0 32 32" aria-hidden="true">
              <rect v-if="shape === 'rectangle'" x="5" y="7" width="22" height="18" />
              <ellipse v-else-if="shape === 'ellipse'" cx="16" cy="16" rx="11" ry="8" />
              <path v-else-if="shape === 'line'" d="M5 24 27 8" />
              <path v-else-if="shape === 'arrow'" d="M5 24 25 9m-9 0h9v9" />
              <path v-else-if="shape === 'triangle'" d="m16 6 12 20H4L16 6Z" />
              <path v-else d="m16 4 12 12-12 12L4 16 16 4Z" />
            </svg>
            <span>{{ t(`shapeMenu.${shape}`) }}</span>
          </button>
        </div>
      </div>
    </Teleport>

    <button
      class="swatch"
      :style="{ background: `radial-gradient(circle at 34% 30%, rgba(255,255,255,.35), rgba(255,255,255,0) 42%), ${store.color}` }"
      :title="t('picker.hint')"
      @click="pickerOpen = true"
    />
    <ColorPicker v-model:open="pickerOpen" />

    <div class="dots">
      <button
        v-for="c in palette"
        :key="c"
        class="dot"
        :class="{ active: store.color.toLowerCase() === c.toLowerCase() }"
        :style="{ background: c }"
        @pointerdown="onDotDown($event, c)"
        @pointermove="onDotMove"
        @pointerup="onDotUp"
        @pointercancel="onDotCancel"
      />
    </div>

    <button class="action icon" @click="pickPhoto" :title="t('canvas.photo')">
      <svg viewBox="0 0 24 24" width="20" height="20">
        <rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="#ddd" stroke-width="1.6" />
        <circle cx="9" cy="10" r="1.8" fill="#ddd" />
        <path d="M4.5 17 L10 12 L14 15.5 L17.5 12.5 L20 15" fill="none" stroke="#ddd" stroke-width="1.6" />
      </svg>
    </button>
    <input
      ref="fileInput"
      type="file"
      accept="image/*"
      hidden
      @change="onPhotoPicked"
    />

    <button class="action" @click="clearPage" :title="t('canvas.clearPage')">⌫</button>

    <div v-if="ghost" class="ghost" :style="{ left: ghost.x + 'px', top: ghost.y + 'px', background: ghost.color }" />
  </div>
</template>

<style scoped>
.tray {
  position: absolute;
  left: 0; right: 0; bottom: 0;
  height: var(--tray-height, 86px);
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
  padding: 8px 10px 14px;
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
.shape-menu {
  position: fixed;
  z-index: 100;
  left: 50%;
  bottom: calc(var(--tray-height, 86px) + 10px);
  transform: translateX(-50%);
  display: grid;
  grid-template-columns: repeat(3, minmax(82px, 1fr));
  gap: 5px;
  width: min(340px, 100%);
  padding: 9px;
  border: 1px solid var(--chrome-border);
  border-radius: 16px;
  background: var(--chrome-bg);
  color: var(--chrome-text);
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.28);
}
.shape-option {
  min-height: 72px;
  border-radius: 10px;
  display: grid;
  align-content: center;
  justify-items: center;
  gap: 5px;
  color: inherit;
  font-size: 11px;
}
.shape-option svg {
  width: 28px;
  height: 28px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.shape-option.selected { background: var(--chrome-hover); color: #2a8097; }
.shape-option:focus-visible { outline: 2px solid #2a8097; outline-offset: 1px; }
.swatch {
  width: 52px;
  height: 52px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.22);
  box-shadow: inset 0 0 8px rgba(0, 0, 0, 0.25), 0 2px 6px rgba(0,0,0,0.4);
  cursor: pointer;
  flex: 0 0 auto;
}
.dots {
  display: grid;
  grid-template-columns: repeat(5, 26px);
  grid-auto-rows: 26px;
  gap: 9px;
}
.dot {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  box-shadow: inset 0 -2px 4px rgba(0,0,0,0.25), 0 1px 3px rgba(0,0,0,0.4);
  cursor: pointer;
}
.dot.active {
  transform: scale(1.2);
}
.ghost {
  position: fixed;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  transform: translate(-50%, -50%);
  pointer-events: none;
  z-index: 100;
  opacity: 0.9;
  box-shadow: 0 2px 8px rgba(0,0,0,0.5);
}
</style>
