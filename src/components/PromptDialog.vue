<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import MobileSlider from './MobileSlider.vue'
import { usePrompt } from '../composables/usePrompt'

const { state, settle } = usePrompt()
const inputEl = ref<HTMLInputElement>()

watch(
  () => state.open,
  async (open) => {
    if (!open) return
    await nextTick()
    inputEl.value?.focus()
    inputEl.value?.select()
  },
)

function onOpenChange(open: boolean) {
  if (!open) settle(null)
}

function submit() {
  const value = state.value.trim()
  if (value) settle(value)
}
</script>

<template>
  <MobileSlider
    :open="state.open"
    :title="state.title"
    size="sm"
    :z-index="80"
    @update:open="onOpenChange"
  >
    <p v-if="state.description" class="dlg-desc">{{ state.description }}</p>
    <input
      ref="inputEl"
      v-model="state.value"
      class="dlg-input"
      :placeholder="state.placeholder"
      :inputmode="state.inputMode"
      enterkeyhint="done"
      @keydown.enter="submit"
    />
    <div class="dlg-actions">
      <button class="dlg-btn" @click="settle(null)">{{ state.cancelText }}</button>
      <button
        class="dlg-btn primary"
        :disabled="!state.value.trim()"
        @click="submit"
      >
        {{ state.confirmText }}
      </button>
    </div>
  </MobileSlider>
</template>

<style scoped>
.dlg-desc {
  color: var(--chrome-muted);
  font-size: 13px;
  margin-bottom: 10px;
}
.dlg-input {
  width: 100%;
  padding: 10px 14px;
  border-radius: 10px;
  border: 1px solid var(--chrome-border);
  background: var(--chrome-input-bg);
  color: var(--chrome-text);
  font-size: 15px;
  outline: none;
}
.dlg-input:focus { border-color: #2a8097; }
.dlg-actions {
  display: flex;
  gap: 10px;
  margin-top: 16px;
}
.dlg-btn {
  flex: 1;
  padding: 11px 0;
  border-radius: 10px;
  background: var(--chrome-control-bg);
  color: var(--chrome-text);
  font-size: 14px;
}
@media (hover: hover) {
  .dlg-btn:hover { background: var(--chrome-hover); }
}
.dlg-btn.primary {
  background: #2a8097;
  color: #fff;
  font-weight: 600;
}
@media (hover: hover) {
  .dlg-btn.primary:hover:not(:disabled) { background: #3894ad; }
}
.dlg-btn.primary:disabled { opacity: 0.4; cursor: default; }
</style>
