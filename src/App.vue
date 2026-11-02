<script setup lang="ts">
import { computed } from 'vue'
import { store } from './store'
import ShelfView from './views/ShelfView.vue'
import JournalView from './views/JournalView.vue'
import CanvasView from './views/CanvasView.vue'
import PromptDialog from './components/PromptDialog.vue'

const comp = computed(() =>
  store.view === 'shelf' ? ShelfView
  : store.view === 'journal' ? JournalView
  : CanvasView,
)

// Remount journal view when switching journals so entrance animations replay.
const viewKey = computed(() =>
  store.view === 'journal' ? `journal-${store.journalId}` : store.view,
)
</script>

<template>
  <Transition name="view" mode="out-in">
    <component :is="comp" :key="viewKey" />
  </Transition>
  <PromptDialog />
</template>
