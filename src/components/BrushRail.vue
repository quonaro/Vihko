<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { brushOf, store } from '../store'
import { INK_TOOLS } from '../ink/tools'

const { t } = useI18n()
const brushSize = computed(() => brushOf(store.tool).size)
const brushProgress = computed(() => Math.min(1, Math.max(0, (brushSize.value - 0.25) / 3.75)))
const brushMarkWidth = computed(() => `${Math.min(20, 7 + brushSize.value * 3)}px`)
</script>

<template>
  <aside
    v-if="!['fill', 'cut', 'move', 'transform'].includes(store.tool)"
    class="brush-rail"
    :class="{ expanded: INK_TOOLS.includes(store.tool) }"
  >
    <span class="brush-value">{{ Math.round(brushSize * 100) }}%</span>
    <div class="brush-control" :style="{ '--brush-mark-width': brushMarkWidth }">
      <div class="brush-mark" />
      <span
        class="brush-thumb"
        :style="{ top: `${100 - brushProgress * 100}%`, width: brushMarkWidth, height: brushMarkWidth }"
      />
      <input
        class="brush-slider"
        type="range"
        min="0.25"
        max="4"
        step="0.05"
        :value="brushSize"
        :aria-label="t('canvas.size')"
        @input="brushOf(store.tool).size = Number(($event.target as HTMLInputElement).value)"
        @pointerdown.stop
      />
    </div>
    <template v-if="INK_TOOLS.includes(store.tool)">
      <span class="brush-value stab">{{ Math.round(brushOf(store.tool).stab * 100) }}%</span>
      <div class="stab-control">
        <div class="stab-track" />
        <span class="stab-thumb" :style="{ top: `${(1 - brushOf(store.tool).stab) * 100}%` }" />
        <input
          class="brush-slider"
          type="range"
          min="0"
          max="1"
          step="0.05"
          :value="brushOf(store.tool).stab"
          :aria-label="t('canvas.stabilize')"
          @input="brushOf(store.tool).stab = Number(($event.target as HTMLInputElement).value)"
          @pointerdown.stop
        />
      </div>
    </template>
  </aside>
</template>

<style scoped>
.brush-rail {
  position: absolute;
  z-index: 12;
  left: 12px;
  top: 50%;
  transform: translateY(-58%);
  width: 48px;
  height: 224px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: space-between;
  padding: 12px 0;
  border: 1px solid var(--brush-panel-border);
  border-radius: 22px;
  background: var(--brush-panel-bg);
  color: var(--brush-panel-text);
  box-shadow: 0 6px 22px var(--brush-panel-shadow);
  backdrop-filter: blur(12px);
}
/* Touch-first devices: the rail overlaps the page on small screens. */
@media (pointer: coarse) {
  .brush-rail { display: none; }
}
.brush-value { font: 600 10px/1 ui-monospace, monospace; color: var(--brush-value); }
.brush-control {
  position: relative;
  width: 24px;
  height: 158px;
  display: grid;
  place-items: center;
}
.brush-mark {
  width: var(--brush-mark-width);
  height: 100%;
  background: var(--brush-mark);
  clip-path: polygon(12% 0, 88% 0, 68% 91%, 58% 99%, 50% 100%, 42% 99%, 32% 91%);
}
.brush-thumb {
  position: absolute;
  left: 50%;
  z-index: 1;
  border: 1px solid var(--brush-thumb-border);
  border-radius: 50%;
  background: var(--brush-thumb);
  box-shadow: 0 1px 3px var(--brush-thumb-shadow);
  transform: translate(-50%, -50%);
  pointer-events: none;
}
.brush-slider {
  position: absolute;
  inset: 0;
  z-index: 2;
  height: 100%;
  width: 100%;
  margin: 0;
  opacity: 0;
  writing-mode: vertical-lr;
  direction: rtl;
  touch-action: none;
}
.brush-rail.expanded {
  height: 306px;
}
.brush-value.stab {
  opacity: 0.65;
}
.stab-control {
  position: relative;
  width: 24px;
  height: 56px;
  display: grid;
  place-items: center;
}
.stab-track {
  width: 3px;
  height: 100%;
  border-radius: 2px;
  background: var(--brush-mark);
}
.stab-thumb {
  position: absolute;
  left: 50%;
  width: 12px;
  height: 12px;
  border: 1px solid var(--brush-thumb-border);
  border-radius: 50%;
  background: var(--brush-thumb);
  box-shadow: 0 1px 3px var(--brush-thumb-shadow);
  transform: translate(-50%, -50%);
  pointer-events: none;
}
</style>
