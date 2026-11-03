<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const props = withDefaults(
  defineProps<{
    open: boolean
    title: string
    size?: 'default' | 'sm'
    zIndex?: number
    noScrollbar?: boolean
  }>(),
  { size: 'default', zIndex: 60 },
)

const emit = defineEmits<{
  'update:open': [value: boolean]
  close: []
}>()

const { t } = useI18n()

const isMobile = ref(false)
let mq: MediaQueryList | undefined
const onMqChange = () => {
  isMobile.value = mq?.matches ?? false
}

const dragOffset = ref<number | null>(null)
const isDragging = ref(false)
let dragStartY = 0
let dragStartedAt = 0
let settleTimer: number | undefined
let savedOverflow: string | null = null

watch(
  () => props.open,
  (open) => {
    if (open) {
      savedOverflow = document.documentElement.style.overflow
      document.documentElement.style.overflow = 'hidden'
    } else if (savedOverflow !== null) {
      document.documentElement.style.overflow = savedOverflow
      savedOverflow = null
    }
  },
  { immediate: true },
)

function onKey(e: KeyboardEvent) {
  if (!props.open || e.key !== 'Escape') return
  e.preventDefault()
  close()
}

onMounted(() => {
  mq = window.matchMedia?.('(max-width: 767px)')
  onMqChange()
  mq?.addEventListener('change', onMqChange)
  window.addEventListener('keydown', onKey)
})

onBeforeUnmount(() => {
  mq?.removeEventListener('change', onMqChange)
  window.removeEventListener('keydown', onKey)
  if (savedOverflow !== null) document.documentElement.style.overflow = savedOverflow
  if (settleTimer !== undefined) window.clearTimeout(settleTimer)
})

function close() {
  emit('update:open', false)
  emit('close')
}

const panelStyle = computed(() =>
  dragOffset.value !== null
    ? {
        transform: `translateY(${dragOffset.value}px)`,
        transition: isDragging.value ? 'none' : undefined,
      }
    : undefined,
)

function startDrag(e: PointerEvent) {
  if (!isMobile.value || !(e.target instanceof Element) || e.target.closest('button, input, a'))
    return
  if (e.pointerType === 'mouse' && e.button !== 0) return
  dragStartY = e.clientY
  dragStartedAt = performance.now()
  dragOffset.value = 0
  isDragging.value = true
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
}

function moveDrag(e: PointerEvent) {
  if (!isDragging.value) return
  dragOffset.value = Math.max(0, e.clientY - dragStartY)
}

function resetDrag() {
  isDragging.value = false
  dragOffset.value = 0
  if (settleTimer !== undefined) window.clearTimeout(settleTimer)
  settleTimer = window.setTimeout(() => {
    dragOffset.value = null
    settleTimer = undefined
  }, 240)
}

function finishDrag() {
  if (!isDragging.value) return
  const distance = dragOffset.value ?? 0
  const elapsed = Math.max(1, performance.now() - dragStartedAt)
  const shouldClose = distance >= 96 || (distance >= 32 && distance / elapsed >= 0.65)
  if (shouldClose) {
    isDragging.value = false
    dragOffset.value = null
    close()
    return
  }
  resetDrag()
}

function cancelDrag() {
  if (isDragging.value) resetDrag()
}
</script>

<template>
  <Teleport to="body">
    <Transition name="mslider">
      <div
        v-if="open"
        class="mslider-backdrop"
        :style="{ zIndex }"
        @click.self="close"
      >
        <section
          role="dialog"
          aria-modal="true"
          :aria-label="title"
          class="mslider"
          :class="{ mobile: isMobile, sm: size === 'sm' }"
          :style="panelStyle"
        >
          <div
            v-if="isMobile"
            class="grab"
            @pointerdown="startDrag"
            @pointermove="moveDrag"
            @pointerup="finishDrag"
            @pointercancel="cancelDrag"
          />
          <header
            class="mslider-head"
            :class="{ grabbable: isMobile }"
            @pointerdown="startDrag"
            @pointermove="moveDrag"
            @pointerup="finishDrag"
            @pointercancel="cancelDrag"
          >
            <h2>{{ title }}</h2>
            <div class="mslider-actions">
              <slot name="actions" />
              <button class="close" :aria-label="t('dlg.close')" @click="close">×</button>
            </div>
          </header>
          <div class="mslider-body" :class="{ 'no-scrollbar': noScrollbar }">
            <slot />
          </div>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.mslider-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: flex-end;
  justify-content: center;
}
.mslider {
  width: 100%;
  max-height: 90dvh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--chrome-bg);
  color: var(--chrome-text);
  border-radius: 18px 18px 0 0;
  padding: 14px 20px max(20px, env(safe-area-inset-bottom));
  box-shadow: var(--chrome-shadow);
  transition: transform 0.22s ease;
}
@media (min-width: 768px) {
  .mslider-backdrop { align-items: center; padding: 16px; }
  .mslider {
    max-width: 640px;
    border-radius: 18px;
    padding: 20px 24px 26px;
    box-shadow: var(--chrome-shadow);
  }
  .mslider.sm { max-width: 400px; }
}
.grab {
  width: 52px;
  height: 22px;
  margin: -2px auto 8px;
  flex-shrink: 0;
  touch-action: none;
  cursor: grab;
}
.grab:active { cursor: grabbing; }
.grab::before {
  content: '';
  display: block;
  width: 40px;
  height: 4px;
  margin: 8px auto 0;
  border-radius: 2px;
  background: var(--chrome-border);
}
.mslider-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
  flex-shrink: 0;
}
.mslider-head.grabbable {
  touch-action: none;
  user-select: none;
}
.mslider-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.mslider-head h2 {
  font-size: 19px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mslider-head .close {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  color: var(--chrome-muted);
  font-size: 20px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
@media (hover: hover) {
  .mslider-head .close:hover { background: var(--chrome-hover); color: var(--chrome-text); }
}
.mslider-body {
  overflow-y: auto;
  min-height: 0;
  scrollbar-width: thin;
  scrollbar-color: var(--chrome-border) transparent;
}
.mslider-body.no-scrollbar {
  overflow-x: hidden;
  scrollbar-width: none;
  /* Android WebView ignores scrollbar CSS — push the bar past .mslider's
     padding so its overflow:hidden clips it (bar thickness < 24px). */
  margin-right: -24px;
  padding-right: 24px;
}
.mslider-body.no-scrollbar::-webkit-scrollbar {
  display: none;
}

.mslider-enter-active,
.mslider-leave-active {
  transition: opacity 180ms ease;
}
.mslider-enter-active .mslider,
.mslider-leave-active .mslider {
  transition: transform 220ms ease;
}
.mslider-enter-from,
.mslider-leave-to {
  opacity: 0;
}
.mslider-enter-from .mslider,
.mslider-leave-to .mslider {
  transform: translateY(1rem);
}
@media (max-width: 767px) {
  .mslider-leave-to .mslider {
    transform: translateY(100%);
  }
}
@media (prefers-reduced-motion: reduce) {
  .mslider-enter-active,
  .mslider-leave-active,
  .mslider-enter-active .mslider,
  .mslider-leave-active .mslider {
    transition-duration: 1ms;
  }
}
</style>
