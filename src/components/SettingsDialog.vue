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
      <span class="set-label"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V4h9l8.6 8.6a2 2 0 0 1 0 .8Z"/><path d="M7.5 7.5h.01"/></svg>{{ t('shelf.version') }}</span>
      <span class="set-value">v{{ appVersion }}</span>
    </div>
    <div class="set-row">
      <span class="set-label"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" stroke="none"/></svg>{{ t('shelf.theme') }}</span>
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
      <span class="set-label"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c-3.8 4.2-3.8 13.8 0 18"/><path d="M12 3c3.8 4.2 3.8 13.8 0 18"/></svg>{{ t('shelf.language') }}</span>
      <div class="seg">
        <button class="seg-btn" :class="{ on: locale === 'en' }" @click="setLocale('en')">English</button>
        <button class="seg-btn" :class="{ on: locale === 'ru' }" @click="setLocale('ru')">Русский</button>
      </div>
    </div>
    <div class="set-row set-col">
      <span class="set-label"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 16.5a8.5 8.5 0 1 1 15 0"/><path d="M12 14l4-5"/><circle cx="12" cy="14" r="1.2" fill="currentColor" stroke="none"/></svg>{{ t('shelf.renderQuality') }}</span>
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
      <span class="set-label"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4.5" y="5" width="15" height="14" rx="2"/><circle cx="9.5" cy="10" r="1.5"/><path d="m5.5 16.5 5-5 3.5 3.5 2.5-2.5 2.5 2.5"/></svg>{{ t('shelf.coverQuality') }}</span>
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
      <span class="set-label"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 3v5h-5"/></svg>{{ t('shelf.updates') }}</span>
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
        <span class="set-label"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8.5a6 6 0 1 0-12 0c0 6.5-2.5 6.5-2.5 8.5h17c0-2-2.5-2-2.5-8.5"/><path d="M10.5 20.5a1.8 1.8 0 0 0 3 0"/></svg>{{ t('shelf.permNotif') }}</span>
        <span v-if="perms.notifications === 'granted'" class="set-value">{{ t('shelf.permGranted') }}</span>
        <button v-else class="set-action" @click="grantNotificationPermission()">{{
          perms.notifications === 'denied' ? t('shelf.permOpenSettings') : t('shelf.permGrant')
        }}</button>
      </div>
      <div class="set-row">
        <span class="set-label"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5 4.5 7.5v9L12 20.5l7.5-4v-9L12 3.5Z"/><path d="M4.5 7.5 12 11.5l7.5-4M12 11.5v9"/></svg>{{ t('shelf.permInstall') }}</span>
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
.set-label {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--chrome-text);
  font-size: 14px;
}
.set-label svg {
  width: 18px;
  height: 18px;
  flex: 0 0 18px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
  color: var(--chrome-muted);
}
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
  min-height: 36px;
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
