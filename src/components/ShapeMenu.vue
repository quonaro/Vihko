<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { store } from '../store'
import type { ShapeKind } from '../types'

const props = defineProps<{ open: boolean }>()

const emit = defineEmits<{ 'update:open': [value: boolean] }>()

const { t } = useI18n()

const shapeMenu = ref<HTMLElement>()
const shapeOptions: ShapeKind[] = ['rectangle', 'ellipse', 'line', 'arrow', 'triangle', 'diamond']

function chooseShape(shape: ShapeKind) {
  store.shape = shape
  store.tool = 'shapes'
  emit('update:open', false)
}

function closeOutside(e: PointerEvent) {
  const target = e.target
  if (
    target instanceof Element &&
    (target.closest('.shape-menu') || target.closest('.tool[aria-expanded]'))
  )
    return
  emit('update:open', false)
}

watch(
  () => props.open,
  async (open) => {
    if (open) {
      await nextTick()
      shapeMenu.value?.focus()
      document.addEventListener('pointerdown', closeOutside)
    } else {
      document.removeEventListener('pointerdown', closeOutside)
    }
  },
)
onBeforeUnmount(() => document.removeEventListener('pointerdown', closeOutside))
</script>

<template>
  <Teleport to="body">
    <div v-if="open">
      <div
        ref="shapeMenu"
        class="shape-menu"
        role="menu"
        tabindex="-1"
        :aria-label="t('shapeMenu.title')"
        @keydown.esc.stop.prevent="emit('update:open', false)"
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
</template>

<style scoped>
.shape-menu {
  position: fixed;
  z-index: 100;
  left: 50%;
  bottom: calc(var(--tray-height, 60px) + 10px);
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
</style>
