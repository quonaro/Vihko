<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { store } from './store'
import { setSystemBarSurface } from './theme'
import { checkForUpdate } from './update'
import ShelfView from './views/ShelfView.vue'
import JournalView from './views/JournalView.vue'
import CanvasView from './views/CanvasView.vue'
import PromptDialog from './components/PromptDialog.vue'

onMounted(() => void checkForUpdate())

// The canvas hides the status bar for a distraction-free editor; the other
// views keep it over their chrome, so the icon color follows the view too.
watch(
  () => store.view,
  (view) => setSystemBarSurface(view === 'canvas' ? 'canvas' : 'app'),
  { immediate: true },
)

const comp = computed(() =>
  store.view === 'shelf' ? ShelfView : store.view === 'journal' ? JournalView : CanvasView,
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
