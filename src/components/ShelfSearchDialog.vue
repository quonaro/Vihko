<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import MobileSlider from './MobileSlider.vue'
import EmptyState from './EmptyState.vue'
import { store, covers } from '../store'

const props = defineProps<{ open: boolean }>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  select: [id: string]
}>()

const { t } = useI18n()
const query = ref('')

const results = computed(() => {
  const q = query.value.trim().toLowerCase()
  return q ? store.journals.filter((j) => j.title.toLowerCase().includes(q)) : store.journals
})

watch(
  () => props.open,
  (open) => {
    if (open) query.value = ''
  },
)
</script>

<template>
  <MobileSlider
    :open="open"
    :title="t('shelf.search')"
    size="sm"
    @update:open="emit('update:open', $event)"
  >
    <input
      v-model="query"
      class="search-input"
      :placeholder="t('shelf.searchPh')"
      autofocus
    />
    <div class="search-results">
      <button
        v-for="j in results"
        :key="j.id"
        class="search-hit"
        @click="emit('select', j.id)"
      >
        <span
          class="hit-cover"
          :style="j.coverImg
            ? { backgroundImage: `url(${j.coverImg})`, backgroundSize: 'cover', backgroundPosition: 'center' }
            : { background: covers[j.cover % covers.length] }"
        />
        <span class="hit-text">
          <span class="hit-title">{{ j.title }}</span>
          <span class="hit-count">{{ t('journal.count', j.pages.length) }}</span>
        </span>
      </button>
      <EmptyState v-if="!results.length" class="search-none" :title="t('shelf.noMatch')">
        <template #icon>
          <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
            <circle cx="10.5" cy="10.5" r="6.5"/>
            <path d="M15.5 15.5 L20 20"/>
          </svg>
        </template>
      </EmptyState>
    </div>
  </MobileSlider>
</template>

<style scoped>
.search-input {
  width: 100%;
  padding: 10px 16px;
  border-radius: 12px;
  border: 1px solid var(--chrome-border);
  background: var(--chrome-input-bg);
  color: var(--chrome-text);
  font-size: 14px;
  outline: none;
}
.search-input:focus { border-color: #2a8097; }
.search-results {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.search-hit {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 10px;
  border-radius: 10px;
  text-align: left;
}
@media (hover: hover) {
  .search-hit:hover { background: var(--chrome-hover); }
}
.hit-cover {
  width: 30px;
  height: 40px;
  border-radius: 2px 5px 5px 2px;
  flex-shrink: 0;
  box-shadow: inset 0 0 0 1px var(--chrome-border);
}
.hit-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.hit-title {
  color: var(--chrome-text);
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hit-count { color: var(--chrome-muted); font-size: 12px; margin-top: 2px; }
.search-none { padding: 18px 0 10px; }
</style>
