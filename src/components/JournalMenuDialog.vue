<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import MobileSlider from './MobileSlider.vue'
import type { Journal } from '../types'

defineProps<{
  open: boolean
  journal: Journal | null
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  rename: []
  export: []
  cover: []
  coverTexture: []
  delete: []
}>()

const { t } = useI18n()
const coverOn = ref(false)

function openCover() {
  emit('update:open', false)
  coverOn.value = true
}

function pickCover(which: 'cover' | 'coverTexture') {
  coverOn.value = false
  if (which === 'cover') emit('cover')
  else emit('coverTexture')
}
</script>

<template>
  <MobileSlider
    :open="open"
    :title="journal?.title ?? t('shelf.menu')"
    size="sm"
    @update:open="emit('update:open', $event)"
  >
    <div class="journal-actions">
      <button class="journal-action" @click="emit('rename')">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20l.8-3.8L16 5l3 3L7.8 19.2 4 20zM14 7l3 3" /></svg>
        {{ t('shelf.rename') }}
      </button>
      <button class="journal-action" @click="emit('export')">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m-4.5-4.5L12 15l4.5-4.5M5.5 19h13" /></svg>
        {{ t('shelf.export') }}
      </button>
      <button class="journal-action" @click="openCover">
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4.5" y="5" width="15" height="14" rx="2" /><circle cx="9.5" cy="10" r="1.5" /><path d="m5.5 16.5 5-5 3.5 3.5 2.5-2.5 2.5 2.5" /></svg>
        {{ t('shelf.cover') }}
      </button>
      <button
        class="journal-action danger"
        @click="journal && emit('delete')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 6.5h15M9.2 6.5l.5-2h4.6l.5 2M6.5 6.5l.9 13h9.2l.9-13M10 10v6m4-6v6" /></svg>
        {{ t('shelf.delete') }}
      </button>
    </div>
  </MobileSlider>

  <MobileSlider
    :open="coverOn"
    :title="t('shelf.cover')"
    size="sm"
    :z-index="70"
    @update:open="coverOn = $event"
  >
    <div class="journal-actions">
      <button class="journal-action" @click="pickCover('cover')">
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4.5" y="5" width="15" height="14" rx="2" /><circle cx="9.5" cy="10" r="1.5" /><path d="m5.5 16.5 5-5 3.5 3.5 2.5-2.5 2.5 2.5" /></svg>
        {{ t('shelf.coverImage') }}
      </button>
      <button class="journal-action" @click="pickCover('coverTexture')">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7.5h16M4 12h16M4 16.5h16" /><circle cx="8" cy="7.5" r="1.5" /><circle cx="15" cy="12" r="1.5" /><circle cx="10" cy="16.5" r="1.5" /></svg>
        {{ t('shelf.coverTexture') }}
      </button>
    </div>
  </MobileSlider>
</template>

<style scoped>
.journal-actions { display: grid; gap: 8px; }
.journal-action {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 13px 16px;
  border-radius: 12px;
  background: var(--chrome-control-bg);
  color: var(--chrome-text);
  text-align: left;
  font-size: 14px;
  font-weight: 600;
}
.journal-action svg {
  width: 19px;
  height: 19px;
  flex: 0 0 19px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.journal-action.danger { color: #c45c52; }
</style>
