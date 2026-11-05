<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import MobileSlider from './MobileSlider.vue'
import { store, currentPage, activeLayer, pushOp } from '../store'
import { pageSize, spreadRect } from '../pageSpace'
import { FILTER_KINDS } from '../types'
import type { FilterKind } from '../types'

defineProps<{ open: boolean }>()

const emit = defineEmits<{ 'update:open': [value: boolean] }>()

const { t } = useI18n()

// Filter tool state — committed as a raster op on the active layer.
const filterKind = ref<FilterKind>('blur')
const filterAmount = ref(4)
const filterAdjust = ref({ brightness: 0, contrast: 0, saturation: 0 })

function applyFilter() {
  const p = currentPage()
  if (!p) return
  const layer = activeLayer()
  // A focused spread half confines the filter's pixels to it.
  const size = pageSize(p)
  const rect = spreadRect(store.spreadMode, size.w, size.h)
  pushOp({
    kind: 'filter',
    filter: filterKind.value,
    amount: filterAmount.value,
    ...(filterKind.value === 'adjust' ? filterAdjust.value : null),
    after: p.strokes.length,
    alphaLock: layer?.alphaLock ? true : undefined,
    rect: rect.w !== size.w ? rect : undefined,
  })
}
</script>

<template>
  <MobileSlider
    :open="open"
    :title="t('filter.title')"
    size="sm"
    @update:open="emit('update:open', $event)"
  >
    <div class="brush-panel">
      <label>{{ t('filter.kind') }}</label>
      <select v-model="filterKind">
        <option v-for="k in FILTER_KINDS" :key="k" :value="k">{{ t(`filter.${k}`) }}</option>
      </select>
      <template v-if="filterKind === 'blur'">
        <label>{{ t('filter.radius') }} <span>{{ filterAmount }}px</span></label>
        <input type="range" min="1" max="16" step="1" v-model.number="filterAmount" />
      </template>
      <template v-else-if="filterKind === 'sharpen'">
        <label>{{ t('filter.amount') }} <span>{{ Math.round(filterAmount * 100) }}%</span></label>
        <input type="range" min="0.2" max="2" step="0.1" v-model.number="filterAmount" />
      </template>
      <template v-else>
        <label>{{ t('filter.brightness') }} <span>{{ Math.round(filterAdjust.brightness * 100) }}%</span></label>
        <input type="range" min="-1" max="1" step="0.05" v-model.number="filterAdjust.brightness" />
        <label>{{ t('filter.contrast') }} <span>{{ Math.round(filterAdjust.contrast * 100) }}%</span></label>
        <input type="range" min="-1" max="1" step="0.05" v-model.number="filterAdjust.contrast" />
        <label>{{ t('filter.saturation') }} <span>{{ Math.round(filterAdjust.saturation * 100) }}%</span></label>
        <input type="range" min="-1" max="1" step="0.05" v-model.number="filterAdjust.saturation" />
      </template>
      <button class="filter-apply" @click="applyFilter">{{ t('filter.apply') }}</button>
    </div>
  </MobileSlider>
</template>

<style scoped>
.brush-panel {
  display: grid;
  gap: 7px;
  padding: 6px 14px 14px;
}
.brush-panel label {
  display: flex;
  justify-content: space-between;
  color: var(--chrome-muted);
  font-size: 11px;
}
.brush-panel label span { color: var(--layer-accent); font-variant-numeric: tabular-nums; }
.brush-panel input[type="range"] { width: 100%; margin: 0; accent-color: var(--layer-accent); }
.brush-panel select {
  width: 100%;
  height: 30px;
  color: var(--chrome-text);
  background: var(--chrome-control-bg);
  border: 1px solid var(--chrome-border);
  border-radius: 8px;
  font-size: 12px;
}
.filter-apply {
  margin-top: 6px;
  padding: 9px;
  border-radius: 10px;
  color: #fff;
  background: var(--layer-accent, #2a8097);
  font-size: 13px;
}
</style>
