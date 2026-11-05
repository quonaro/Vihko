<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { palette, store } from '../store'
import { hexToHsv, hsvToHex, mixColors } from '../ink/mix'
import MobileSlider from './MobileSlider.vue'
import { logger } from '../log'

const log = logger('color')

// Arbitrary color picker: saturation/value square + hue strip + hex field.
// Commits to store.color live while dragging.
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ 'update:open': [value: boolean] }>()

const { t } = useI18n()

const h = ref(0)
const s = ref(0)
const v = ref(0)
const hexText = ref('')
const hexBad = ref(false)

const color = computed(() => hsvToHex(h.value, s.value, v.value))
const hueCss = computed(() => hsvToHex(h.value, 1, 1))

watch(
  () => props.open,
  (open) => {
    if (!open) return
    ;[h.value, s.value, v.value] = hexToHsv(store.color)
    hexText.value = store.color
    hexBad.value = false
  },
  { immediate: true },
)

function apply() {
  store.color = color.value
  hexText.value = color.value
  hexBad.value = false
  log.debug('color applied', color.value)
}

function selectColor(hex: string) {
  ;[h.value, s.value, v.value] = hexToHsv(hex)
  apply()
}

function onHex(e: Event) {
  const raw = (e.target as HTMLInputElement).value.trim()
  hexText.value = raw
  if (!/^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.test(raw)) {
    hexBad.value = true
    return
  }
  ;[h.value, s.value, v.value] = hexToHsv(raw.startsWith('#') ? raw : `#${raw}`)
  apply()
}

let dragColor: string | null = null
const ghost = ref<{ color: string; x: number; y: number } | null>(null)

function onPaletteDown(e: PointerEvent, color: string) {
  dragColor = color
  ghost.value = { color, x: e.clientX, y: e.clientY }
  ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
}

function onPaletteMove(e: PointerEvent) {
  if (ghost.value) ghost.value = { ...ghost.value, x: e.clientX, y: e.clientY }
}

function onPaletteUp(e: PointerEvent) {
  if (!dragColor) return
  const target = document.elementFromPoint(e.clientX, e.clientY)
  if (target?.classList.contains('new')) {
    log.debug('palette drop blends into the swatch', dragColor)
    selectColor(mixColors(store.color, dragColor, 0.35))
  } else if (Math.abs(e.movementY) < 40) {
    selectColor(dragColor)
  }
  dragColor = null
  ghost.value = null
}

function onPaletteCancel() {
  dragColor = null
  ghost.value = null
}

const sv = ref<HTMLElement>()
const hue = ref<HTMLElement>()
let svDrag = false
let hueDrag = false

function pos(e: PointerEvent, el: HTMLElement) {
  const r = el.getBoundingClientRect()
  const x = Math.min(1, Math.max(0, (e.clientX - r.left) / (r.width || 1)))
  const y = Math.min(1, Math.max(0, (e.clientY - r.top) / (r.height || 1)))
  return [x, y] as const
}

function svDown(e: PointerEvent) {
  svDrag = true
  sv.value!.setPointerCapture(e.pointerId)
  svMove(e)
}
function svMove(e: PointerEvent) {
  if (!svDrag) return
  const [x, y] = pos(e, sv.value!)
  s.value = x
  v.value = 1 - y
  apply()
}
function svUp() {
  svDrag = false
}

function hueDown(e: PointerEvent) {
  hueDrag = true
  hue.value!.setPointerCapture(e.pointerId)
  hueMove(e)
}
function hueMove(e: PointerEvent) {
  if (!hueDrag) return
  h.value = pos(e, hue.value!)[0] * 360
  apply()
}
function hueUp() {
  hueDrag = false
}
</script>

<template>
  <MobileSlider
    :open="open"
    :title="t('picker.title')"
    size="sm"
    @update:open="emit('update:open', $event)"
  >
    <div class="picker">
      <div
        ref="sv"
        class="sv"
        :style="{
          background: `linear-gradient(to top, #000, rgba(0,0,0,0)), linear-gradient(to right, #fff, rgba(255,255,255,0)), ${hueCss}`,
        }"
        @pointerdown="svDown"
        @pointermove="svMove"
        @pointerup="svUp"
        @pointercancel="svUp"
      >
        <div
          class="thumb"
          :style="{ left: `${s * 100}%`, top: `${(1 - v) * 100}%`, background: color }"
        />
      </div>

      <div
        ref="hue"
        class="hue"
        @pointerdown="hueDown"
        @pointermove="hueMove"
        @pointerup="hueUp"
        @pointercancel="hueUp"
      >
        <div class="hthumb" :style="{ left: `${(h / 360) * 100}%` }" />
      </div>

      <div class="row">
        <div class="new" :style="{ background: color }" />
        <input
          class="hex"
          :class="{ bad: hexBad }"
          :value="hexText"
          :aria-label="t('picker.hex')"
          placeholder="#rrggbb"
          spellcheck="false"
          @input="onHex"
        />
      </div>

      <div class="dots">
        <button
          v-for="c in palette"
          :key="c"
          class="dot"
          :class="{ active: store.color.toLowerCase() === c.toLowerCase() }"
          :style="{ background: c }"
          :aria-label="c"
          @pointerdown="onPaletteDown($event, c)"
          @pointermove="onPaletteMove"
          @pointerup="onPaletteUp"
          @pointercancel="onPaletteCancel"
        />
      </div>
      <div
        v-if="ghost"
        class="ghost"
        :style="{ left: `${ghost.x}px`, top: `${ghost.y}px`, background: ghost.color }"
      />
    </div>
  </MobileSlider>
</template>

<style scoped>
.picker {
  display: flex;
  flex-direction: column;
  gap: 14px;
  width: 100%;
  min-width: 0;
  overflow-x: clip;
}
.sv {
  position: relative;
  height: 190px;
  border-radius: 12px;
  touch-action: none;
  cursor: crosshair;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12);
}
.thumb {
  position: absolute;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 2.5px solid #fff;
  transform: translate(-50%, -50%);
  box-shadow: 0 1px 5px rgba(0, 0, 0, 0.6);
  pointer-events: none;
}
.hue {
  position: relative;
  height: 26px;
  border-radius: 13px;
  touch-action: none;
  cursor: ew-resize;
  background: linear-gradient(
    to right,
    #f00 0%,
    #ff0 16.6%,
    #0f0 33.3%,
    #0ff 50%,
    #00f 66.6%,
    #f0f 83.3%,
    #f00 100%
  );
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12);
}
.hthumb {
  position: absolute;
  top: 50%;
  width: 14px;
  height: 30px;
  border-radius: 7px;
  border: 2.5px solid #fff;
  transform: translate(-50%, -50%);
  box-shadow: 0 1px 5px rgba(0, 0, 0, 0.6);
  pointer-events: none;
}
.row {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  width: 100%;
  min-width: 0;
}
.new {
  width: 44px;
  height: 44px;
  border-radius: 10px;
  flex-shrink: 0;
  border: 1px solid rgba(255, 255, 255, 0.2);
  box-shadow: inset 0 -3px 6px rgba(0, 0, 0, 0.25);
}
.hex {
  min-width: 0;
  height: 44px;
  padding: 0 14px;
  border-radius: 10px;
  border: 0;
  outline: none;
  background: var(--chrome-input-bg);
  color: var(--chrome-text);
  font: 15px/1 ui-monospace, monospace;
  transition: background-color 140ms ease;
}
.hex::placeholder {
  color: var(--chrome-muted);
}
.hex:focus {
  background: var(--chrome-control-bg);
}
.hex.bad {
  background: rgba(226, 96, 30, 0.12);
}
.dots {
  display: grid;
  grid-template-columns: repeat(5, 34px);
  grid-auto-rows: 34px;
  justify-content: center;
  gap: 10px;
}
.dot {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  box-shadow: inset 0 -2px 4px rgba(0, 0, 0, 0.25), 0 1px 3px rgba(0, 0, 0, 0.4);
  cursor: pointer;
  touch-action: none;
}
.dot.active {
  transform: scale(1.1);
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
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
}
</style>
