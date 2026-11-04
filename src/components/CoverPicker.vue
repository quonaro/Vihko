<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import MobileSlider from './MobileSlider.vue'
import { presetCovers } from '../covers'
import { imageFileToPhoto } from '../ink/ops'
import type { Journal } from '../types'

defineProps<{
  open: boolean
  journal: Journal | null
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  select: [src: string | null]
}>()

const { t } = useI18n()
const coverInput = ref<HTMLInputElement>()

async function onCoverPicked(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  const img = await imageFileToPhoto(file, 1600)
  emit('select', img.src)
}
</script>

<template>
  <MobileSlider
    :open="open"
    :title="t('shelf.cover')"
    no-scrollbar
    @update:open="emit('update:open', $event)"
  >
    <p class="hint cover-hint">{{ journal?.title }}</p>
    <div class="cover-grid">
      <button
        v-for="c in presetCovers"
        :key="c.id"
        class="cover-option"
        :style="{ backgroundImage: `url(${c.src})` }"
        @click="emit('select', c.src)"
      />
      <button class="cover-option upload" @click="coverInput?.click()">
        {{ t('shelf.uploadCover') }}
      </button>
      <button
        v-if="journal?.coverImg"
        class="cover-option plain remove-cover"
        :aria-label="t('shelf.removeCover')"
        :title="t('shelf.removeCover')"
        @click="emit('select', null)"
      >
        <svg
          viewBox="0 0 24 24"
          width="24"
          height="24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <rect x="3.5" y="5" width="17" height="14" rx="2" />
          <circle cx="9" cy="10" r="1.5" />
          <path d="m5 17 5-5 3 3 2-2 4 4M4 4l16 16" />
        </svg>
      </button>
    </div>
    <input ref="coverInput" type="file" accept="image/*" hidden @change="onCoverPicked" />
  </MobileSlider>
</template>

<style scoped>
.hint { color: var(--chrome-muted); font-size: 13px; }
.cover-hint { margin: -4px 0 14px; }
.cover-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
}
.cover-option {
  aspect-ratio: 34 / 48;
  border-radius: 8px;
  background-size: cover;
  background-position: center;
  border: 1px solid var(--chrome-border);
  cursor: pointer;
  color: var(--chrome-muted);
  font-size: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 6px;
}
.cover-option.upload, .cover-option.plain {
  background: var(--chrome-input-bg);
}
</style>
