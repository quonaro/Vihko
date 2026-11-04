<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import MobileSlider from './MobileSlider.vue'
import { store } from '../store'
import { PAGE_SIZE_PRESETS } from '../pageSpace'

defineProps<{ open: boolean }>()

const emit = defineEmits<{ 'update:open': [value: boolean] }>()

const { t } = useI18n()
const sizePresets = PAGE_SIZE_PRESETS

function selectPageSize(id: (typeof PAGE_SIZE_PRESETS)[number]['id']) {
  store.pageSize = id
  emit('update:open', false)
}
</script>

<template>
  <MobileSlider
    :open="open"
    :title="t('journal.pageSize')"
    size="sm"
    @update:open="emit('update:open', $event)"
  >
    <div class="page-size-options" role="group" :aria-label="t('journal.pageSize')">
      <button
        v-for="s in sizePresets"
        :key="s.id"
        class="page-size-option"
        :class="{ selected: store.pageSize === s.id }"
        :aria-pressed="store.pageSize === s.id"
        @click="selectPageSize(s.id)"
      >
        <span class="size-preview" :style="{ width: `${36 * s.w / s.h}px` }" aria-hidden="true"></span>
        <span class="size-label">{{ t(`journal.size.${s.id}`) }}</span>
        <svg v-if="store.pageSize === s.id" class="size-check" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
          <path d="m4 10 4 4 8-8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    </div>
  </MobileSlider>
</template>

<style scoped>
.page-size-options {
  display: grid;
  gap: 8px;
  padding-bottom: 2px;
}
.page-size-option {
  min-height: 64px;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 14px;
  border: 1px solid var(--chrome-border);
  border-radius: 12px;
  color: var(--chrome-text);
  text-align: left;
  background: transparent;
  transition: background .16s ease, border-color .16s ease;
}
.page-size-option.selected {
  border-color: var(--chrome-text);
  background: var(--chrome-hover);
}
@media (hover: hover) {
  .page-size-option:hover { background: var(--chrome-hover); }
}
.size-preview {
  flex: 0 0 auto;
  height: 36px;
  max-width: 58px;
  border: 1.5px solid currentColor;
  border-radius: 3px;
  opacity: .8;
}
.size-label {
  flex: 1;
  font-size: 14px;
  font-weight: 500;
}
.size-check { color: var(--chrome-text); }
</style>
