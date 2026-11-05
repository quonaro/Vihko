<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import MobileSlider from './MobileSlider.vue'
import {
  store,
  pageLayers,
  activeLayer,
  addLayer,
  selectLayer,
  updateLayer,
  reorderLayer,
  deleteLayer,
} from '../store'
import { BLEND_MODES } from '../types'
import type { BlendMode } from '../types'
import { logger } from '../log'

const log = logger('layers')

const props = defineProps<{
  open: boolean
  // dataURL thumbnail per layer id; built by the view (needs the ink engine).
  thumb: (id: string) => string
}>()

const emit = defineEmits<{ 'update:open': [value: boolean] }>()

const { t } = useI18n()

const layers = computed(() => pageLayers())
const displayLayers = computed(() => [...layers.value].reverse())
const selectedLayer = computed(() => activeLayer())

function toggleLayerMask(on: boolean) {
  const layer = selectedLayer.value
  if (!layer) return
  log.debug('layer mask edit', { layer: layer.id, on })
  updateLayer(layer.id, { mask: on || undefined })
  store.maskEdit = on
}

// --- grip-drag reordering --------------------------------------------------

const layerList = ref<HTMLElement>()
const draggingLayerId = ref<string | null>(null)
const layerDropIndex = ref<number | null>(null)
let layerDragPointerId: number | null = null

function startLayerReorder(e: PointerEvent, id: string) {
  if (e.pointerType === 'mouse' && e.button !== 0) return
  e.preventDefault()
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  layerDragPointerId = e.pointerId
  draggingLayerId.value = id
  layerDropIndex.value = displayLayers.value.findIndex((layer) => layer.id === id)
}

function moveLayerReorder(e: PointerEvent) {
  if (layerDragPointerId !== e.pointerId) return
  const target = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
  const row = target?.closest<HTMLElement>('.layer-row')
  if (!row || !layerList.value?.contains(row)) return
  const targetIndex = Number(row.dataset.displayIndex)
  const bounds = row.getBoundingClientRect()
  const fromIndex = displayLayers.value.findIndex((layer) => layer.id === draggingLayerId.value)
  let toIndex = targetIndex + (e.clientY > bounds.top + bounds.height / 2 ? 1 : 0)
  if (toIndex > fromIndex) toIndex--
  layerDropIndex.value = Math.max(0, Math.min(displayLayers.value.length - 1, toIndex))
}

function finishLayerReorder(e: PointerEvent) {
  if (layerDragPointerId !== e.pointerId) return
  const id = draggingLayerId.value
  const displayIndex = layerDropIndex.value
  cancelLayerReorder()
  if (id && displayIndex !== null) {
    log.debug('layer reordered', { id, displayIndex })
    reorderLayer(id, displayLayers.value.length - 1 - displayIndex)
  }
}

function cancelLayerReorder() {
  layerDragPointerId = null
  draggingLayerId.value = null
  layerDropIndex.value = null
}

watch(
  () => props.open,
  (open) => {
    if (!open) cancelLayerReorder()
  },
)
</script>

<template>
  <MobileSlider
    :open="open"
    :title="t('layers.title')"
    size="sm"
    :z-index="1000"
    @update:open="emit('update:open', $event)"
  >
    <template #actions>
      <button class="layer-add" :title="t('layers.add')" :aria-label="t('layers.add')" @click="addLayer">+</button>
    </template>
    <div ref="layerList" class="layer-list">
      <div
        v-for="(layer, index) in displayLayers"
        :key="layer.id"
        class="layer-row"
        :data-layer-id="layer.id"
        :data-display-index="index"
        :class="{
          active: selectedLayer?.id === layer.id,
          dragging: draggingLayerId === layer.id,
          'drop-target': layerDropIndex === index && draggingLayerId !== layer.id,
        }"
        @click="selectLayer(layer.id)"
      >
        <button class="layer-eye" @click.stop="updateLayer(layer.id, { visible: !layer.visible })" :title="layer.visible ? t('layers.hide') : t('layers.show')">
          {{ layer.visible ? '◉' : '○' }}
        </button>
        <img
          v-if="thumb(layer.id)"
          class="layer-thumb"
          :src="thumb(layer.id)"
          :alt="layer.name"
        />
        <div v-else class="layer-thumb" />
        <input
          v-model="layer.name"
          class="layer-name"
          :aria-label="t('layers.name')"
          @click.stop
          @change="updateLayer(layer.id, { name: layer.name })"
        />
        <button
          class="layer-grab"
          :title="t('layers.reorder')"
          :aria-label="t('layers.reorder')"
          @pointerdown.stop="startLayerReorder($event, layer.id)"
          @pointermove="moveLayerReorder"
          @pointerup="finishLayerReorder"
          @pointercancel="cancelLayerReorder"
          @lostpointercapture="cancelLayerReorder"
          @click.stop
        >⠿</button>
        <button class="layer-delete" :disabled="layers.length <= 1" @click.stop="deleteLayer(layer.id)" :title="t('layers.delete')">×</button>
      </div>
    </div>
    <div v-if="selectedLayer" class="layer-properties">
      <label>{{ t('layers.opacity') }} <span>{{ Math.round(selectedLayer.opacity * 100) }}%</span></label>
      <input
        type="range" min="0" max="1" step="0.01" :value="selectedLayer.opacity"
        @input="updateLayer(selectedLayer.id, { opacity: Number(($event.target as HTMLInputElement).value) })"
      />
      <label>{{ t('layers.blend') }}</label>
      <select
        class="layer-blend"
        :value="selectedLayer.blend ?? 'source-over'"
        :aria-label="t('layers.blend')"
        @change="updateLayer(selectedLayer.id, { blend: ($event.target as HTMLSelectElement).value as BlendMode })"
      >
        <option v-for="mode in BLEND_MODES" :key="mode" :value="mode">
          {{ t(`layers.blends.${mode}`) }}
        </option>
      </select>
      <label class="layer-flag">
        <input
          type="checkbox"
          :checked="!!selectedLayer.alphaLock"
          @change="updateLayer(selectedLayer.id, { alphaLock: ($event.target as HTMLInputElement).checked })"
        />
        {{ t('layers.alphaLock') }}
      </label>
      <label class="layer-flag">
        <input
          type="checkbox"
          :checked="!!selectedLayer.clip"
          @change="updateLayer(selectedLayer.id, { clip: ($event.target as HTMLInputElement).checked })"
        />
        {{ t('layers.clip') }}
      </label>
      <label class="layer-flag">
        <input
          type="checkbox"
          :checked="!!selectedLayer.mask"
          @change="toggleLayerMask(($event.target as HTMLInputElement).checked)"
        />
        {{ t('layers.mask') }}
      </label>
      <label v-if="selectedLayer.mask" class="layer-flag">
        <input type="checkbox" v-model="store.maskEdit" />
        {{ t('layers.maskEdit') }}
      </label>
    </div>
  </MobileSlider>
</template>

<style scoped>
.layer-add, .layer-delete, .layer-eye, .layer-grab {
  display: grid;
  place-items: center;
  line-height: 1;
  color: var(--chrome-text);
  background: transparent;
  border-radius: 8px;
}
.layer-add {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  font-size: 24px;
  background: var(--chrome-control-bg);
}
@media (hover: hover) {
  .layer-add:hover { background: var(--chrome-hover); }
}
.layer-list { min-height: 48px; padding: 6px 3px; overscroll-behavior: contain; }
.layer-row {
  position: relative;
  min-height: 42px;
  display: flex;
  align-items: center;
  gap: 3px;
  border: 1px solid transparent;
  border-radius: 9px;
  padding: 3px;
}
.layer-row.active { border-color: var(--layer-active-border); background: var(--layer-active-bg); }
.layer-row.dragging { opacity: .38; }
.layer-row.drop-target { outline: 2px solid var(--layer-accent-bg); outline-offset: 1px; }
.layer-eye { width: 28px; height: 30px; font-size: 14px; }
.layer-thumb {
  width: 46px;
  height: 30px;
  flex: 0 0 auto;
  object-fit: contain;
  border-radius: 5px;
  border: 1px solid var(--chrome-border);
  background:
    repeating-conic-gradient(rgba(128,128,128,.28) 0% 25%, rgba(255,255,255,.28) 0% 50%) 0 0 / 8px 8px;
}
.layer-name {
  min-width: 30px;
  flex: 1;
  height: 30px;
  padding: 0;
  color: var(--chrome-text);
  background: transparent;
  border: 0;
  outline: 0;
  font-size: 12px;
  line-height: 30px;
}
.layer-grab {
  width: 30px;
  height: 30px;
  flex: 0 0 auto;
  font-size: 19px;
  color: var(--chrome-muted);
  cursor: grab;
  touch-action: none;
  user-select: none;
}
.layer-grab:active { cursor: grabbing; }
.layer-delete { width: 28px; height: 30px; font-size: 18px; }
.layer-delete:disabled { opacity: .25; }
.layer-properties {
  display: grid;
  gap: 5px;
  padding: 10px 14px 13px;
  border-top: 1px solid var(--chrome-border);
}
.layer-properties label {
  display: flex;
  justify-content: space-between;
  color: var(--chrome-muted);
  font-size: 11px;
  margin-top: 2px;
}
.layer-properties label span { color: var(--layer-accent); font-variant-numeric: tabular-nums; }
.layer-properties input[type="range"] { width: 100%; margin: 0; accent-color: var(--layer-accent); }
.layer-blend {
  width: 100%;
  height: 30px;
  color: var(--chrome-text);
  background: var(--chrome-control-bg);
  border: 1px solid var(--chrome-border);
  border-radius: 8px;
  font-size: 12px;
}
.layer-properties label.layer-flag {
  justify-content: flex-start;
  align-items: center;
  gap: 8px;
  color: var(--chrome-text);
  font-size: 12px;
  cursor: pointer;
}
.layer-flag input { accent-color: var(--layer-accent); margin: 0; }
</style>
