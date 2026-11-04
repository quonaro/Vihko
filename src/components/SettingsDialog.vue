<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import MobileSlider from './MobileSlider.vue'
import { setLocale } from '../i18n'
import { setTheme, theme } from '../theme'
import { QUALITY_LEVELS, glQuality, coverQuality, setGlQuality, setCoverQuality } from '../quality'
import {
  appVersion,
  update,
  checkForUpdate,
  downloadUpdate,
  perms,
  permsRelevant,
  refreshPermissions,
  grantNotificationPermission,
  grantInstallPermission,
} from '../update'

const props = defineProps<{ open: boolean }>()

const emit = defineEmits<{ 'update:open': [value: boolean] }>()

const { t, locale } = useI18n()

const updateLabel = computed(() => {
  switch (update.dl) {
    case 'downloading':
      return t('shelf.downloading', { n: update.progress })
    case 'ready':
      return t('shelf.installUpdate', { v: update.latest })
    case 'error':
      return t('shelf.downloadFailed')
    default:
      return t('shelf.updateAvailable', { v: update.latest })
  }
})

// --- Permissions (Android) ---------------------------------------------------

const showPerms = permsRelevant()

// Re-read states when the sheet opens and when the user returns from a system
// settings screen (e.g. after toggling "install unknown apps").
function onVisible() {
  if (!document.hidden) void refreshPermissions()
}
watch(
  () => props.open,
  (on) => {
    if (!showPerms) return
    if (on) {
      void refreshPermissions()
      document.addEventListener('visibilitychange', onVisible)
    } else {
      document.removeEventListener('visibilitychange', onVisible)
    }
  },
)
onBeforeUnmount(() => document.removeEventListener('visibilitychange', onVisible))
</script>

<template>
  <MobileSlider
    :open="open"
    :title="t('shelf.settings')"
    size="sm"
    @update:open="emit('update:open', $event)"
  >
    <div class="set-row">
      <span class="set-label">{{ t('shelf.version') }}</span>
      <span class="set-value">v{{ appVersion }}</span>
    </div>
    <div class="set-row">
      <span class="set-label">{{ t('shelf.theme') }}</span>
      <div class="seg">
        <button
          class="seg-btn"
          :class="{ on: theme === 'light' }"
          :aria-pressed="theme === 'light'"
          @click="setTheme('light')"
        >{{ t('shelf.themeLight') }}</button>
        <button
          class="seg-btn"
          :class="{ on: theme === 'dark' }"
          :aria-pressed="theme === 'dark'"
          @click="setTheme('dark')"
        >{{ t('shelf.themeDark') }}</button>
      </div>
    </div>
    <div class="set-row">
      <span class="set-label">{{ t('shelf.language') }}</span>
      <div class="seg">
        <button class="seg-btn" :class="{ on: locale === 'en' }" @click="setLocale('en')">English</button>
        <button class="seg-btn" :class="{ on: locale === 'ru' }" @click="setLocale('ru')">Русский</button>
      </div>
    </div>
    <div class="set-row set-col">
      <span class="set-label">{{ t('shelf.renderQuality') }}</span>
      <div class="seg">
        <button
          v-for="q in QUALITY_LEVELS"
          :key="q"
          class="seg-btn"
          :class="{ on: glQuality === q }"
          :aria-pressed="glQuality === q"
          @click="setGlQuality(q)"
        >{{ t(`shelf.quality.${q}`) }}</button>
      </div>
    </div>
    <div class="set-row set-col">
      <span class="set-label">{{ t('shelf.coverQuality') }}</span>
      <div class="seg">
        <button
          v-for="q in QUALITY_LEVELS"
          :key="q"
          class="seg-btn"
          :class="{ on: coverQuality === q }"
          :aria-pressed="coverQuality === q"
          @click="setCoverQuality(q)"
        >{{ t(`shelf.quality.${q}`) }}</button>
      </div>
    </div>
    <div class="set-row">
      <span class="set-label">{{ t('shelf.updates') }}</span>
      <button
        class="set-action"
        :class="{ accent: update.status === 'available' }"
        :disabled="update.busy || update.dl === 'downloading'"
        @click="update.status === 'available' ? downloadUpdate() : checkForUpdate()"
      >{{ update.busy ? t('shelf.checking')
        : update.status === 'available'
          ? (update.dl === 'idle' ? t('shelf.updateNow', { v: update.latest }) : updateLabel)
          : update.status === 'error' ? t('shelf.checkFailed')
          : t('shelf.checkUpdate') }}</button>
    </div>
    <template v-if="showPerms">
      <div class="set-row">
        <span class="set-label">{{ t('shelf.permNotif') }}</span>
        <span v-if="perms.notifications === 'granted'" class="set-value">{{ t('shelf.permGranted') }}</span>
        <button v-else class="set-action" @click="grantNotificationPermission()">{{
          perms.notifications === 'denied' ? t('shelf.permOpenSettings') : t('shelf.permGrant')
        }}</button>
      </div>
      <div class="set-row">
        <span class="set-label">{{ t('shelf.permInstall') }}</span>
        <span v-if="perms.install === 'granted'" class="set-value">{{ t('shelf.permGranted') }}</span>
        <button v-else class="set-action" @click="grantInstallPermission()">{{ t('shelf.permOpenSettings') }}</button>
      </div>
    </template>
  </MobileSlider>
</template>

<style scoped>
.set-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
}
.set-row + .set-row { margin-top: 14px; }
/* 4-button segments don't fit next to their label — stack and stretch. */
.set-col {
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
}
.set-col .seg-btn { flex: 1; padding: 7px 0; }
.set-label { color: var(--chrome-text); font-size: 14px; }
.seg {
  display: flex;
  gap: 3px;
  padding: 3px;
  border-radius: 10px;
  background: var(--chrome-control-bg);
}
.seg-btn {
  padding: 7px 18px;
  border-radius: 8px;
  color: var(--chrome-muted);
  font-size: 13px;
  font-weight: 650;
}
.seg-btn.on { background: #2a8097; color: #fff; }
.set-value {
  color: var(--chrome-muted);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.set-action {
  padding: 7px 16px;
  border-radius: 8px;
  background: var(--chrome-control-bg);
  color: var(--chrome-text);
  font-size: 13px;
  font-weight: 650;
}
.set-action.accent {
  background: #2a8097;
  color: #fff;
}
.set-action:disabled { opacity: .6; }
</style>
