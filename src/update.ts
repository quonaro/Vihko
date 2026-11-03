import { reactive } from 'vue'
import pkg from '../package.json'

// Release builds get the tag via VITE_APP_VERSION (see release.yml);
// dev builds fall back to package.json.
export const appVersion = (import.meta.env.VITE_APP_VERSION || pkg.version).replace(/^v/, '')

const REPO = 'quonaro/Vihko'
export const releasesUrl = `https://github.com/${REPO}/releases`

export type UpdateStatus = 'idle' | 'checking' | 'uptodate' | 'available' | 'error'

export const update = reactive({
  status: 'idle' as UpdateStatus,
  busy: false,
  latest: '',
  url: releasesUrl,
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
    const data: { tag_name?: string; html_url?: string } = await res.json()
    const tag = data.tag_name ?? ''
    update.latest = tag.replace(/^v/, '')
    update.url = data.html_url || releasesUrl
    update.status = isNewerVersion(tag) ? 'available' : 'uptodate'
  } catch {
    update.status = 'error'
  } finally {
    update.busy = false
  }
  return update.status
}
