import { Capacitor } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
import { logger } from './log'

const log = logger('save')

// <a download> is a no-op inside the Android/iOS WebView, so on native the
// file is written to the cache and handed to the system share sheet, which
// offers Save to Files/Photos/Drive. On the web it stays a plain download.
export async function saveFile(name: string, data: Blob | string): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    log.debug('saving via <a download>', name)
    const blob = typeof data === 'string' ? new Blob([data]) : data
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = name
    a.click()
    URL.revokeObjectURL(a.href)
    return
  }
  log.debug('saving via cache + share sheet', name)
  const path = `exports/${name}`
  await Filesystem.writeFile({ path, data, directory: Directory.Cache, recursive: true })
  const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache })
  await Share.share({ url: uri, title: name })
}
