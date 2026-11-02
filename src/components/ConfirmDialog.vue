<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import MobileSlider from './MobileSlider.vue'

defineProps<{
  open: boolean
  title: string
  message: string
}>()

const emit = defineEmits<{
  confirm: []
  cancel: []
}>()

const { t } = useI18n()

function onOpenUpdate(open: boolean) {
  if (!open) emit('cancel')
}
</script>

<template>
  <MobileSlider
    :open="open"
    :title="title"
    size="sm"
    @update:open="onOpenUpdate"
  >
    <p id="confirm-message" class="confirm-message">{{ message }}</p>
    <div class="confirm-actions">
      <button class="confirm-cancel" autofocus @click="emit('cancel')">{{ t('dlg.cancel') }}</button>
      <button class="confirm-delete" @click="emit('confirm')">{{ t('dlg.delete') }}</button>
    </div>
  </MobileSlider>
</template>

<style scoped>
.confirm-message {
  margin: 2px 0 20px;
  color: var(--chrome-muted);
  font-size: 14px;
  line-height: 1.5;
}
.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding-bottom: 4px;
}
.confirm-actions button {
  min-height: 42px;
  padding: 0 16px;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 650;
}
.confirm-cancel {
  color: var(--chrome-text);
  background: var(--chrome-control-bg);
}
.confirm-delete {
  color: #fff;
  background: #a33c32;
}
@media (hover: hover) {
  .confirm-cancel:hover { background: var(--chrome-hover); }
  .confirm-delete:hover { background: #8f3028; }
}
</style>
