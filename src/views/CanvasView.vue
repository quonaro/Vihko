<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import BrushRail from '../components/BrushRail.vue'
import LayerPanel from '../components/LayerPanel.vue'
import ToolTray from '../components/ToolTray.vue'
import { useCanvasView } from '../composables/useCanvasView'

const { t } = useI18n()
const {
  canvas,
  view,
  navClass,
  journal,
  pageIndex,
  layerPanelOpen,
  layerThumb,
  TRAY_HEIGHT,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  cycleSymmetry,
  cycleGuide,
  undoOk,
  redoOk,
  importPhoto,
  reRender,
  store,
  undoStroke,
  redoStroke,
  closeToJournal,
} = useCanvasView()
</script>

<template>
  <div class="canvas-view" :style="{ '--tray-height': `${TRAY_HEIGHT}px` }">
    <BrushRail />

    <div class="viewport">
      <canvas
        ref="canvas"
        :class="[navClass, { grab: store.tool === 'move' }]"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @pointerleave="onPointerUp"
        @contextmenu.prevent
      />
    </div>

    <button class="close-btn" @click="closeToJournal" :title="t('canvas.close')">
      <svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6 L18 18 M18 6 L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
    </button>

    <div class="page-badge" v-if="journal">
      {{ journal.title }} — {{ pageIndex + 1 }}/{{ journal.pages.length }}
    </div>

    <div class="top-actions">
      <button class="round-btn" :disabled="!undoOk" @click="undoStroke() && reRender()" :title="t('canvas.undo')">
        <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>
      </button>
      <button class="round-btn" :disabled="!redoOk" @click="redoStroke() && reRender()" :title="t('canvas.redo')">
        <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 14 20 9 15 4"/><path d="M4 20v-7a4 4 0 0 1 4-4h12"/></svg>
      </button>
      <button class="round-btn" :class="{ selected: layerPanelOpen }" @click="layerPanelOpen = !layerPanelOpen" :title="t('layers.title')">
        <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/></svg>
      </button>
      <button class="round-btn" :class="{ selected: store.symmetry !== 'none' }" @click="cycleSymmetry" :title="t('canvas.symmetry')">
        <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M8 5 4 8l4 3V5ZM8 13l-4 3 4 3v-6ZM16 5l4 3-4 3V5ZM16 13l4 3-4 3v-6Z"/><path v-if="store.symmetry === 'h' || store.symmetry === 'xy'" d="M4 12h16" stroke-dasharray="2 2"/><path v-if="store.symmetry === 'v' || store.symmetry === 'xy'" d="M12 4v16" stroke-dasharray="2 2"/></svg>
      </button>
      <button class="round-btn" :class="{ selected: store.guide !== 'off' }" @click="cycleGuide" :title="t('canvas.guide')">
        <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path v-if="store.guide === 'arc'" d="M4 18a8 8 0 0 1 16 0"/><path v-else d="M4 18 20 6"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/></svg>
      </button>
    </div>

    <LayerPanel v-model:open="layerPanelOpen" :thumb="layerThumb" />

    <ToolTray @photo="importPhoto" />
  </div>
</template>

<style scoped>
.canvas-view {
  position: relative;
  height: 100%;
  background: #2a2a2c;
}
.viewport {
  position: absolute;
  inset: 0 0 var(--tray-height) 0;
  overflow: hidden;
}
canvas {
  display: block;
  width: 100%;
  /* Keep the drawing viewport above the overlaying tool tray. */
  height: 100%;
  touch-action: none;
  transform-origin: 50% 50%;
}
canvas.from-right { animation: slide-from-right 0.28s ease; }
canvas.from-left { animation: slide-from-left 0.28s ease; }
canvas.grab { cursor: grab; }
.close-btn {
  position: absolute;
  top: 16px;
  left: 18px;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: rgba(40, 40, 42, 0.75);
  color: #eee;
  display: grid;
  place-items: center;
  z-index: 20;
}
@media (hover: hover) {
  .close-btn:hover { background: rgba(40, 40, 42, 0.9); }
}
.top-actions {
  position: absolute;
  top: 16px;
  right: 18px;
  display: flex;
  gap: 10px;
  z-index: 20;
}
.round-btn {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: rgba(40, 40, 42, 0.75);
  color: #eee;
  display: grid;
  place-items: center;
}
@media (hover: hover) {
  .round-btn:hover { background: rgba(40, 40, 42, 0.9); }
}
.round-btn:disabled { opacity: 0.35; cursor: default; }
.round-btn.selected { color: #6dbbcf; background: rgba(40, 40, 42, .95); }
.page-badge {
  position: absolute;
  top: 26px;
  left: 50%;
  transform: translateX(-50%);
  color: rgba(60, 55, 45, 0.55);
  font-size: 13px;
  pointer-events: none;
}
</style>
