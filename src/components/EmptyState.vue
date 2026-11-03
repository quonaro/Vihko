<script setup lang="ts">
defineProps<{
  title: string
  hint?: string
}>()
</script>

<template>
  <div class="empty-state" role="status">
    <div v-if="$slots.icon" class="empty-icon"><slot name="icon" /></div>
    <p class="empty-title">{{ title }}</p>
    <p v-if="hint" class="empty-hint">{{ hint }}</p>
  </div>
</template>

<style scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 24px;
  text-align: center;
  animation: fade-in 0.25s ease;
}
.empty-icon {
  display: flex;
  margin-bottom: 4px;
  opacity: 0.42;
}
.empty-title {
  font-size: 15px;
  font-weight: 650;
}
.empty-hint {
  max-width: 250px;
  font-size: 13px;
  line-height: 1.45;
  opacity: 0.6;
}
</style>
