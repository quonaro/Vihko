<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import MobileSlider from './MobileSlider.vue'
import { store } from '../store'
import { useTextInput } from '../composables/useTextInput'
import { TEXT_FONTS, TEXT_ALIGNS } from '../types'
import { textFontFamily } from '../ink/text'
import { customFonts, importFontFile, removeCustomFont } from '../fonts'
import { logger } from '../log'

const log = logger('text-dialog')
const { t } = useI18n()
const { state, settle } = useTextInput()
const area = ref<HTMLTextAreaElement>()
const fileInput = ref<HTMLInputElement>()
const importing = ref(false)
const importError = ref('')

// Live preview: the textarea renders in the selected face; the page-unit size
// is mapped onto a readable 14–26px range so the slider still shows a change.
const previewStyle = computed(() => {
  const t = Math.max(0, Math.min(1, (store.text.size - 24) / 296))
  return {
    fontFamily: textFontFamily(store.text.font),
    fontWeight: store.text.bold ? '700' : '400',
    fontStyle: store.text.italic ? 'italic' : 'normal',
    fontSize: `${14 + t * 12}px`,
  }
})

watch(
  () => state.open,
  async (open) => {
    importError.value = ''
    if (!open) return
    await nextTick()
    area.value?.focus()
  },
)

function save() {
  const value = state.value.trim()
  if (value) settle(value)
}

function onOpenChange(open: boolean) {
  if (!open) settle(null)
}

function pickFont() {
  fileInput.value?.click()
}

async function onFontsPicked(e: Event) {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (!files.length) return
  importError.value = ''
  importing.value = true
  try {
    let last: Awaited<ReturnType<typeof importFontFile>> | null = null
    for (const file of files) last = await importFontFile(file)
    if (last) store.text.font = last.id
  } catch (error) {
    log.warn('font import failed', error)
    importError.value =
      error instanceof Error && error.message === 'font-save-failed'
        ? t('text.fontSaveFailed')
        : t('text.fontImportFailed')
  } finally {
    importing.value = false
  }
}

async function removeFont(id: string) {
  await removeCustomFont(id)
  if (store.text.font === id) store.text.font = 'sans'
}
</script>

<template>
  <MobileSlider
    :open="state.open"
    :title="t('text.title')"
    size="sm"
    :z-index="80"
    @update:open="onOpenChange"
  >
    <textarea
      ref="area"
      v-model="state.value"
      class="text-input"
      :style="previewStyle"
      rows="3"
      :placeholder="t('text.placeholder')"
      enterkeyhint="enter"
      @keydown.ctrl.enter.prevent="save"
      @keydown.meta.enter.prevent="save"
    />

    <label class="text-label">
      {{ t('text.size') }} <span>{{ Math.round(store.text.size) }}</span>
    </label>
    <input
      class="text-range"
      type="range"
      min="24"
      max="320"
      step="4"
      :value="store.text.size"
      :aria-label="t('text.size')"
      @input="store.text.size = Number(($event.target as HTMLInputElement).value)"
    />

    <label class="text-label">{{ t('text.font') }}</label>
    <div class="text-row fonts">
      <button
        v-for="font in TEXT_FONTS"
        :key="font"
        class="text-chip"
        :class="{ selected: store.text.font === font }"
        :style="{ fontFamily: textFontFamily(font) }"
        @click="store.text.font = font"
      >
        {{ t(`text.fonts.${font}`) }}
      </button>
      <button class="text-chip import" :disabled="importing" @click="pickFont">
        {{ importing ? '…' : t('text.importFont') }}
      </button>
    </div>

    <template v-if="customFonts.length">
      <label class="text-label">{{ t('text.importedFonts') }}</label>
      <div class="text-row fonts">
        <span v-for="font in customFonts" :key="font.id" class="font-slot">
          <button
            class="text-chip"
            :class="{ selected: store.text.font === font.id }"
            :style="{ fontFamily: textFontFamily(font.id) }"
            :title="font.name"
            @click="store.text.font = font.id"
          >
            {{ font.name }}
          </button>
          <button
            class="font-remove"
            :aria-label="t('text.removeFont')"
            :title="t('text.removeFont')"
            @click="removeFont(font.id)"
          >
            ×
          </button>
        </span>
      </div>
    </template>

    <p v-if="importError" class="text-error">{{ importError }}</p>

    <input
      ref="fileInput"
      type="file"
      accept=".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2"
      multiple
      hidden
      @change="onFontsPicked"
    />

    <div class="text-row">
      <button
        class="text-chip icon bold"
        :class="{ selected: store.text.bold }"
        :aria-label="t('text.bold')"
        :aria-pressed="store.text.bold"
        @click="store.text.bold = !store.text.bold"
      >
        B
      </button>
      <button
        class="text-chip icon italic"
        :class="{ selected: store.text.italic }"
        :aria-label="t('text.italic')"
        :aria-pressed="store.text.italic"
        @click="store.text.italic = !store.text.italic"
      >
        I
      </button>
      <span class="spacer" />
      <button
        v-for="align in TEXT_ALIGNS"
        :key="align"
        class="text-chip icon"
        :class="{ selected: store.text.align === align }"
        :aria-label="t(`text.align.${align}`)"
        :aria-pressed="store.text.align === align"
        @click="store.text.align = align"
      >
        <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">
          <g stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <template v-if="align === 'left'">
              <path d="M3 5h14M3 10h9M3 15h12" />
            </template>
            <template v-else-if="align === 'right'">
              <path d="M3 5h14M8 10h9M5 15h12" />
            </template>
            <template v-else>
              <path d="M3 5h14M5.5 10h9M4 15h12" />
            </template>
          </g>
        </svg>
      </button>
    </div>

    <div class="text-actions">
      <button class="text-btn" @click="settle(null)">{{ t('dlg.cancel') }}</button>
      <button class="text-btn primary" :disabled="!state.value.trim()" @click="save">
        {{ t('text.add') }}
      </button>
    </div>
  </MobileSlider>
</template>

<style scoped>
.text-input {
  width: 100%;
  min-height: 84px;
  resize: vertical;
  padding: 10px 14px;
  border-radius: 10px;
  border: 1px solid var(--chrome-border);
  background: var(--chrome-input-bg);
  color: var(--chrome-text);
  font-size: 15px;
  line-height: 1.35;
  outline: none;
}
.text-input:focus { border-color: #2a8097; }
.text-label {
  display: flex;
  justify-content: space-between;
  margin: 14px 0 6px;
  font-size: 13px;
  color: var(--chrome-muted);
}
.text-range { width: 100%; }
.text-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  flex-wrap: wrap;
}
.text-row.fonts { margin-top: 0; }
.spacer { flex: 1; }
.text-chip {
  min-width: 40px;
  height: 38px;
  padding: 0 12px;
  border-radius: 10px;
  border: 1px solid var(--chrome-border);
  background: var(--chrome-control-bg);
  color: var(--chrome-text);
  font-size: 15px;
}
.text-chip.icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}
.text-chip.bold { font-weight: 700; }
.text-chip.italic { font-style: italic; font-family: Georgia, serif; }
.text-chip.import {
  border-style: dashed;
  color: var(--chrome-muted);
}
.text-chip:disabled { opacity: 0.5; cursor: default; }
.text-chip.selected {
  border-color: #2a8097;
  color: #2a8097;
  background: color-mix(in srgb, #2a8097 14%, transparent);
}
.font-slot {
  position: relative;
  display: inline-flex;
}
.font-slot .text-chip {
  max-width: 180px;
  padding-right: 26px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.font-remove {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 1px solid var(--chrome-border);
  background: var(--chrome-bg);
  color: var(--chrome-muted);
  font-size: 14px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
@media (hover: hover) {
  .font-remove:hover { color: #c45a4a; border-color: #c45a4a; }
}
.text-error {
  margin-top: 10px;
  font-size: 13px;
  color: #c45a4a;
}
.text-actions {
  display: flex;
  gap: 10px;
  margin-top: 18px;
}
.text-btn {
  flex: 1;
  padding: 11px 0;
  border-radius: 10px;
  background: var(--chrome-control-bg);
  color: var(--chrome-text);
  font-size: 14px;
}
@media (hover: hover) {
  .text-btn:hover { background: var(--chrome-hover); }
}
.text-btn.primary {
  background: #2a8097;
  color: #fff;
  font-weight: 600;
}
@media (hover: hover) {
  .text-btn.primary:hover:not(:disabled) { background: #3894ad; }
}
.text-btn.primary:disabled { opacity: 0.4; cursor: default; }
</style>
