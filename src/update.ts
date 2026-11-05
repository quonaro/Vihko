import { reactive } from 'vue'
import { Capacitor, registerPlugin } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'
import { i18n } from './i18n'
import { logger } from './log'
import pkg from '../package.json'

const log = logger('update')

// Release builds get the tag via VITE_APP_VERSION (see release.yml);
// local builds fall back to `git describe` (see vite.config.ts), then package.json.
export const appVersion = (import.meta.env.VITE_APP_VERSION || pkg.version).replace(/^v/, '')

const REPO = 'quonaro/Vihko'
export const releasesUrl = `https://github.com/${REPO}/releases`

// Native plugin (android/app/.../ApkInstallerPlugin.java) that fires the
// system package-installer intent on a downloaded APK via FileProvider and
// mirrors the download into the notification shade.
interface ApkInstallerPlugin {
  install(options: { path: string }): Promise<void>
  notifyProgress(options: { percent: number; title: string; body: string }): Promise<void>
  notifyComplete(options: { path: string; title: string; body: string }): Promise<void>
  notifyFailed(options: { title: string; body: string }): Promise<void>
  installState(): Promise<{ granted: boolean }>
  openInstallSettings(): Promise<void>
  openAppSettings(): Promise<void>
  checkPermissions(): Promise<{ notifications: string }>
  requestPermissions(): Promise<{ notifications: string }>
}
const ApkInstaller = registerPlugin<ApkInstallerPlugin>('ApkInstaller')

// Notification posts are best-effort — a denied POST_NOTIFICATIONS or a
// plugin hiccup must not break the download.
const notify = (p: Promise<void>) => void p.catch(() => {})

// --- Permissions ------------------------------------------------------------

export type PermState = 'granted' | 'denied' | 'prompt' | 'prompt-with-rationale' | 'unknown'

const onAndroid = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'

export const perms = reactive({
  notifications: 'unknown' as PermState,
  install: 'unknown' as 'granted' | 'denied' | 'unknown',
})

// The permission UI is Android-only (custom ApkInstaller plugin).
export const permsRelevant = (): boolean => onAndroid()

export async function refreshPermissions(): Promise<void> {
  if (!onAndroid()) return
  try {
    perms.notifications = ((await ApkInstaller.checkPermissions()).notifications ||
      'unknown') as PermState
  } catch (e) {
    perms.notifications = 'unknown'
    log.debug('checkPermissions failed', e)
  }
  try {
    perms.install = (await ApkInstaller.installState()).granted ? 'granted' : 'denied'
  } catch (e) {
    perms.install = 'unknown'
    log.debug('installState failed', e)
  }
  log.debug('permissions', { ...perms })
}

// Called once on app start: asks for the notification runtime permission.
// "Install unknown apps" has no runtime dialog — it's granted from a system
// settings screen, so it's only surfaced in the settings sheet / install flow.
export async function requestStartupPermissions(): Promise<void> {
  if (!onAndroid()) return
  try {
    await ApkInstaller.requestPermissions()
  } catch {
    /* non-fatal */
  }
  await refreshPermissions()
}

// Notifications: 'denied' means the system dialog won't show again — open the
// app settings page instead of calling requestPermissions into the void.
export async function grantNotificationPermission(): Promise<void> {
  try {
    if (perms.notifications === 'denied') {
      log.debug('notifications hard-denied, opening app settings')
      await ApkInstaller.openAppSettings()
    } else await ApkInstaller.requestPermissions()
  } catch (e) {
    /* non-fatal */
    log.debug('notification permission request failed', e)
  }
  await refreshPermissions()
}

export async function grantInstallPermission(): Promise<void> {
  try {
    await ApkInstaller.openInstallSettings()
  } catch {
    /* non-fatal */
  }
  await refreshPermissions()
}

export type UpdateStatus = 'idle' | 'checking' | 'uptodate' | 'available' | 'error'
export type DownloadState = 'idle' | 'downloading' | 'ready' | 'error'

export const update = reactive({
  status: 'idle' as UpdateStatus,
  busy: false,
  latest: '',
  url: releasesUrl,
  apkUrl: '',
  // APK self-update progress on Android: downloading → ready (install intent
  // fired; the system dialog takes over from there) or error.
  dl: 'idle' as DownloadState,
  progress: 0,
  apkPath: '',
})

function parseVer(v: string): number[] | null {
  const m = v.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

export function isNewerVersion(latest: string, current: string = appVersion): boolean {
  const a = parseVer(latest)
  const b = parseVer(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

export async function checkForUpdate(): Promise<UpdateStatus> {
  if (update.busy) return update.status
  update.busy = true
  log.debug('checking for updates', { current: appVersion })
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
    })
    // No published releases (or draft-only) reads as "nothing newer".
    if (res.status === 404) {
      update.status = 'uptodate'
      log.debug('no published releases')
      return update.status
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data: {
      tag_name?: string
      html_url?: string
      assets?: { name?: string; browser_download_url?: string }[]
    } = await res.json()
    const tag = data.tag_name ?? ''
    update.latest = tag.replace(/^v/, '')
    update.url = data.html_url || releasesUrl
    const apk = (data.assets ?? []).find((a) => a.name?.endsWith('.apk'))
    update.apkUrl = apk?.browser_download_url ?? ''
    update.status = isNewerVersion(tag) ? 'available' : 'uptodate'
    update.dl = 'idle'
    update.progress = 0
    update.apkPath = ''
    log.info('update check done', {
      status: update.status,
      latest: update.latest,
      apkUrl: !!update.apkUrl,
    })
  } catch (e) {
    update.status = 'error'
    log.warn('update check failed', e)
  } finally {
    update.busy = false
  }
  return update.status
}

// Android downloads the release APK into the app cache and hands it to the
// system installer; other platforms fall back to opening the release page.
export async function downloadUpdate(): Promise<void> {
  const openReleasePage = () => window.open(update.url, '_blank', 'noopener')
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') {
    log.debug('non-Android platform, opening the release page')
    openReleasePage()
    return
  }
  if (update.dl === 'downloading') return
  if (!update.apkUrl) {
    log.debug('no apk asset in the release, opening the release page')
    openReleasePage()
    return
  }
  log.info('downloading update apk', update.apkUrl)
  try {
    if (!update.apkPath) {
      update.dl = 'downloading'
      update.progress = 0
      const path = `updates/vihko-${update.latest || 'update'}.apk`
      // downloadFile's `recursive` flag is ignored on Android — the parent
      // dir must exist beforehand or FileOutputStream fails with ENOENT.
      await Filesystem.mkdir({
        path: 'updates',
        directory: Directory.Cache,
        recursive: true,
      }).catch(() => {})
      const listener = await Filesystem.addListener('progress', (p) => {
        update.progress =
          p.contentLength > 0 ? Math.min(100, Math.round((p.bytes / p.contentLength) * 100)) : 0
        notify(
          ApkInstaller.notifyProgress({
            percent: update.progress,
            title: i18n.global.t('shelf.dlNotifProgressTitle'),
            body: i18n.global.t('shelf.dlNotifBody', { v: update.latest }),
          }),
        )
      })
      try {
        await Filesystem.downloadFile({
          url: update.apkUrl,
          path,
          directory: Directory.Cache,
          progress: true,
          recursive: true,
        })
      } finally {
        await listener.remove()
      }
      const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache })
      update.apkPath = uri.replace(/^file:\/\//, '')
      notify(
        ApkInstaller.notifyComplete({
          path: update.apkPath,
          title: i18n.global.t('shelf.dlNotifDoneTitle'),
          body: i18n.global.t('shelf.dlNotifDoneBody', { v: update.latest }),
        }),
      )
    }
    update.dl = 'ready'
    log.info('apk ready, firing the install intent', update.apkPath)
    await ApkInstaller.install({ path: update.apkPath })
  } catch (e) {
    log.error('downloadUpdate failed', e)
    update.dl = 'error'
    update.apkPath = ''
    notify(
      ApkInstaller.notifyFailed({
        title: i18n.global.t('shelf.dlNotifFailTitle'),
        body: i18n.global.t('shelf.dlNotifBody', { v: update.latest }),
      }),
    )
  }
}
