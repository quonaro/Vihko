import { Capacitor } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'

// <a download> is a no-op inside the Android/iOS WebView, so on native the
// file is written to the cache and handed to the system share sheet, which
// offers Save to Files/Photos/Drive. On the web it stays a plain download.
export async function saveFile(name: string, data: Blob | string): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    const blob = typeof data === 'string' ? new Blob([data]) : data
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = name
    a.click()
    URL.revokeObjectURL(a.href)
    return
  }
  const path = `exports/${name}`
  await Filesystem.writeFile({ path, data, directory: Directory.Cache, recursive: true })
  const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache })
  await Share.share({ url: uri, title: name })
}
