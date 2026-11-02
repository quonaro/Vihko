<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { store } from '../store'
import { hexToHsv, hsvToHex } from '../ink/mix'
import MobileSlider from './MobileSlider.vue'

// Arbitrary color picker: saturation/value square + hue strip + hex field.
// Commits to store.color live while dragging; the "current" swatch restores
// the color the page had when the dialog was opened.
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ 'update:open': [value: boolean] }>()

const { t } = useI18n()

const h = ref(0)
const s = ref(0)
const v = ref(0)
const original = ref(store.color)
const hexText = ref('')
const hexBad = ref(false)

const color = computed(() => hsvToHex(h.value, s.value, v.value))
const hueCss = computed(() => hsvToHex(h.value, 1, 1))

watch(
  () => props.open,
  (open) => {
    if (!open) return
    original.value = store.color
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
}

function revert() {
  ;[h.value, s.value, v.value] = hexToHsv(original.value)
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
        <button
          class="old"
          :style="{ background: original }"
          :title="t('picker.revert')"
          @click="revert"
        />
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
  grid-template-columns: 44px 44px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  width: 100%;
  min-width: 0;
}
.old,
.new {
  width: 44px;
  height: 44px;
  border-radius: 10px;
  flex-shrink: 0;
  box-shadow:
    inset 0 -3px 6px rgba(0, 0, 0, 0.25),
    0 0 0 1px rgba(255, 255, 255, 0.14);
}
.old {
  cursor: pointer;
}
.hex {
  min-width: 0;
  height: 44px;
  padding: 0 14px;
  border-radius: 10px;
  border: 0;
  outline: none;
  background: rgba(0, 0, 0, 0.045);
  color: #111;
  font: 15px/1 ui-monospace, monospace;
  transition: background-color 140ms ease;
}
.hex::placeholder {
  color: #85857f;
}
.hex:focus {
  background: rgba(0, 0, 0, 0.075);
}
.hex.bad {
  background: rgba(226, 96, 30, 0.12);
}
:deep(.mslider-body) {
  overflow-x: hidden;
}
</style>
