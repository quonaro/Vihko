<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import MobileSlider from './MobileSlider.vue'
import { COVER_TEXTURES, type CoverTexture, type Journal } from '../types'

defineProps<{
  open: boolean
  journal: Journal | null
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  select: [texture: CoverTexture]
}>()

const { t } = useI18n()
const coverTextures = COVER_TEXTURES
</script>

<template>
  <MobileSlider
    :open="open"
    :title="t('shelf.coverTexture')"
    size="sm"
    @update:open="emit('update:open', $event)"
  >
    <p class="hint texture-hint">{{ journal?.title }}</p>
    <div class="texture-options" role="group" :aria-label="t('shelf.coverTexture')">
      <button
        v-for="texture in coverTextures"
        :key="texture"
        class="texture-option"
        :class="[
          `texture-${texture}`,
          { selected: (journal?.coverTexture ?? 'paper') === texture },
        ]"
        :aria-pressed="(journal?.coverTexture ?? 'paper') === texture"
        @click="emit('select', texture)"
      >
        <span class="texture-swatch" aria-hidden="true"></span>
        <span class="texture-copy">
          <span class="texture-name">{{ t(`shelf.texture.${texture}.title`) }}</span>
          <span class="texture-description">{{ t(`shelf.texture.${texture}.hint`) }}</span>
        </span>
        <svg
          v-if="(journal?.coverTexture ?? 'paper') === texture"
          class="texture-check"
          viewBox="0 0 20 20"
          width="20"
          height="20"
          aria-hidden="true"
        >
          <path d="m4 10 4 4 8-8" />
        </svg>
      </button>
    </div>
  </MobileSlider>
</template>

<style scoped>
.hint { color: var(--chrome-muted); font-size: 13px; }
.texture-hint { margin: -4px 0 14px; }
.texture-options { display: grid; gap: 8px; }
.texture-option {
  min-height: 72px;
  display: flex;
  align-items: center;
  gap: 13px;
  padding: 9px 12px;
  border: 1px solid var(--chrome-border);
  border-radius: 12px;
  color: var(--chrome-text);
  text-align: left;
  background: transparent;
  transition: background .16s ease, border-color .16s ease;
}
.texture-option.selected {
  border-color: var(--chrome-text);
  background: var(--chrome-hover);
}
.texture-swatch {
  width: 40px;
  height: 50px;
  flex: 0 0 40px;
  border: 1px solid rgba(30, 27, 24, .18);
  border-radius: 5px;
  background-color: #b7a98e;
  box-shadow: 0 2px 4px rgba(0, 0, 0, .12);
}
.texture-smooth .texture-swatch { background-color: #718792; }
.texture-comic .texture-swatch {
  background-color: #dfb77e;
  background-image: radial-gradient(rgba(32, 28, 24, .62) 1px, transparent 1.25px);
  background-size: 5px 5px;
}
.texture-paper .texture-swatch {
  background-image:
    repeating-linear-gradient(12deg, rgba(255,255,255,.12) 0 1px, transparent 1px 4px),
    repeating-linear-gradient(103deg, rgba(48,39,30,.08) 0 1px, transparent 1px 5px);
}
.texture-copy { min-width: 0; flex: 1; display: grid; gap: 3px; }
.texture-name { font-size: 14px; font-weight: 600; }
.texture-description { color: var(--chrome-muted); font-size: 12px; }
.texture-check {
  flex: 0 0 20px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
@media (hover: hover) {
  .texture-option:hover { background: var(--chrome-hover); }
}
</style>
