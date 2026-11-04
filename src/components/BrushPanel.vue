<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import MobileSlider from './MobileSlider.vue'
import { store, brushOf, applyBrushPreset, saveBrushPreset } from '../store'
import { BLEND_MODES, BRUSH_TIPS } from '../types'
import type { BlendMode, BrushTip } from '../types'

defineProps<{ open: boolean }>()

const emit = defineEmits<{ 'update:open': [value: boolean] }>()

const { t } = useI18n()

const activeBrush = () => brushOf(store.tool)
</script>

<template>
  <MobileSlider
    :open="open"
    :title="t(`tool.${store.tool}`)"
    size="sm"
    @update:open="emit('update:open', $event)"
  >
    <div class="brush-panel">
      <label>{{ t('canvas.size') }} <span>{{ Math.round(activeBrush().size * 100) }}%</span></label>
      <input
        type="range" min="0.25" max="4" step="0.05" :value="activeBrush().size"
        @input="activeBrush().size = Number(($event.target as HTMLInputElement).value)"
      />
      <label>{{ t('brush.opacity') }} <span>{{ Math.round(activeBrush().opacity * 100) }}%</span></label>
      <input
        type="range" min="0.05" max="1" step="0.01" :value="activeBrush().opacity"
        @input="activeBrush().opacity = Number(($event.target as HTMLInputElement).value)"
      />
      <label>{{ t('canvas.stabilize') }} <span>{{ Math.round(activeBrush().stab * 100) }}%</span></label>
      <input
        type="range" min="0" max="1" step="0.05" :value="activeBrush().stab"
        @input="activeBrush().stab = Number(($event.target as HTMLInputElement).value)"
      />
      <label>{{ t('layers.blend') }}</label>
      <select
        :value="activeBrush().blend ?? 'source-over'"
        @change="activeBrush().blend = ($event.target as HTMLSelectElement).value as BlendMode"
      >
        <option v-for="m in BLEND_MODES" :key="m" :value="m">{{ t(`layers.blends.${m}`) }}</option>
      </select>
      <label>{{ t('brush.tip') }}</label>
      <select
        :value="activeBrush().tip ?? 'round'"
        @change="activeBrush().tip = ($event.target as HTMLSelectElement).value as BrushTip"
      >
        <option v-for="tip in BRUSH_TIPS" :key="tip" :value="tip">{{ t(`brush.tips.${tip}`) }}</option>
      </select>
      <template v-if="activeBrush().tip && activeBrush().tip !== 'round'">
        <label>{{ t('brush.spacing') }} <span>{{ Math.round((activeBrush().spacing ?? 0.3) * 100) }}%</span></label>
        <input
          type="range" min="0.05" max="1" step="0.05" :value="activeBrush().spacing ?? 0.3"
          @input="activeBrush().spacing = Number(($event.target as HTMLInputElement).value)"
        />
        <label>{{ t('brush.jitter') }} <span>{{ Math.round((activeBrush().jitter ?? 0) * 100) }}%</span></label>
        <input
          type="range" min="0" max="1" step="0.05" :value="activeBrush().jitter ?? 0"
          @input="activeBrush().jitter = Number(($event.target as HTMLInputElement).value)"
        />
        <label>{{ t('brush.scatter') }} <span>{{ Math.round((activeBrush().scatter ?? 0) * 100) }}%</span></label>
        <input
          type="range" min="0" max="1" step="0.05" :value="activeBrush().scatter ?? 0"
          @input="activeBrush().scatter = Number(($event.target as HTMLInputElement).value)"
        />
        <label class="brush-flag">
          <input
            type="checkbox"
            :checked="!!activeBrush().angle"
            @change="activeBrush().angle = ($event.target as HTMLInputElement).checked ? 1 : 0"
          />
          {{ t('brush.angle') }}
        </label>
      </template>
      <template v-if="store.tool === 'color'">
        <label>{{ t('brush.wet') }} <span>{{ Math.round((activeBrush().wet ?? 0.6) * 100) }}%</span></label>
        <input
          type="range" min="0" max="1" step="0.05" :value="activeBrush().wet ?? 0.6"
          @input="activeBrush().wet = Number(($event.target as HTMLInputElement).value)"
        />
      </template>
      <label>{{ t('brush.presets') }}</label>
      <div class="brush-presets">
        <button
          v-for="p in store.brushPresets"
          :key="p.id"
          class="preset"
          @click="applyBrushPreset(p)"
        >
          {{ t(p.name) }}
        </button>
        <button class="preset add" :title="t('brush.savePreset')" @click="saveBrushPreset()">+</button>
      </div>
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
.brush-flag {
  justify-content: flex-start !important;
  align-items: center;
  gap: 8px;
  color: var(--chrome-text) !important;
  font-size: 12px !important;
  cursor: pointer;
}
.brush-flag input { accent-color: var(--layer-accent); margin: 0; }
.brush-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.preset {
  padding: 7px 12px;
  border-radius: 16px;
  color: var(--chrome-text);
  background: var(--chrome-control-bg);
  border: 1px solid var(--chrome-border);
  font-size: 12px;
}
@media (hover: hover) {
  .preset:hover { background: var(--chrome-hover); }
}
.preset.add { min-width: 34px; font-size: 16px; line-height: 1; }
</style>
