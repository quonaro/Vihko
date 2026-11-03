import { reactive } from 'vue'
import { Capacitor, registerPlugin } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'
import pkg from '../package.json'

// Release builds get the tag via VITE_APP_VERSION (see release.yml);
// dev builds fall back to package.json.
export const appVersion = (import.meta.env.VITE_APP_VERSION || pkg.version).replace(/^v/, '')

const REPO = 'quonaro/Vihko'
export const releasesUrl = `https://github.com/${REPO}/releases`

// Native plugin (android/app/.../ApkInstallerPlugin.java) that fires the
// system package-installer intent on a downloaded APK via FileProvider.
interface ApkInstallerPlugin {
  install(options: { path: string }): Promise<void>
}
const ApkInstaller = registerPlugin<ApkInstallerPlugin>('ApkInstaller')

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
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
    })
    // No published releases (or draft-only) reads as "nothing newer".
    if (res.status === 404) {
      update.status = 'uptodate'
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
  } catch {
    update.status = 'error'
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
    openReleasePage()
    return
  }
  if (update.dl === 'downloading') return
  if (!update.apkUrl) {
    openReleasePage()
    return
  }
  try {
    if (!update.apkPath) {
      update.dl = 'downloading'
      update.progress = 0
      const path = `updates/vihko-${update.latest || 'update'}.apk`
      const listener = await Filesystem.addListener('progress', (p) => {
        update.progress = p.contentLength > 0
          ? Math.min(100, Math.round((p.bytes / p.contentLength) * 100))
          : 0
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
    }
    update.dl = 'ready'
    await ApkInstaller.install({ path: update.apkPath })
  } catch {
    update.dl = 'error'
    update.apkPath = ''
  }
}
