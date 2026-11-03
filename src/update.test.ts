import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const native = vi.hoisted(() => ({
  isNative: vi.fn(() => false),
  getPlatform: vi.fn(() => 'web'),
  install: vi.fn(async () => {}),
  notifyProgress: vi.fn(async () => {}),
  notifyComplete: vi.fn(async () => {}),
  notifyFailed: vi.fn(async () => {}),
  progressCb: null as null | ((p: { bytes: number; contentLength: number }) => void),
  downloadFile: vi.fn(async () => ({})),
  getUri: vi.fn(async () => ({ uri: 'file:///cache/updates/vihko-9.9.9.apk' })),
  addListener: vi.fn(async (_e: string, cb: (p: { bytes: number; contentLength: number }) => void) => {
    native.progressCb = cb
    return { remove: vi.fn(async () => {}) }
  }),
}))

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: native.isNative,
    getPlatform: native.getPlatform,
  },
  registerPlugin: () => ({
    install: native.install,
    notifyProgress: native.notifyProgress,
    notifyComplete: native.notifyComplete,
    notifyFailed: native.notifyFailed,
  }),
}))
vi.mock('@capacitor/filesystem', () => ({
  Directory: { Cache: 'CACHE' },
  Filesystem: {
    downloadFile: native.downloadFile,
    getUri: native.getUri,
    addListener: native.addListener,
  },
}))

import { appVersion, update, checkForUpdate, isNewerVersion, downloadUpdate } from './update'

const stubReleases = (body: unknown, status = 200) =>
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response)))

const goAndroid = () => {
  native.isNative.mockReturnValue(true)
  native.getPlatform.mockReturnValue('android')
}

beforeEach(() => {
  vi.clearAllMocks()
  native.isNative.mockReturnValue(false)
  native.getPlatform.mockReturnValue('web')
  update.status = 'idle'
  update.busy = false
  update.latest = ''
  update.url = 'https://example.com/rel'
  update.apkUrl = ''
  update.dl = 'idle'
  update.progress = 0
  update.apkPath = ''
})

afterEach(() => vi.unstubAllGlobals())

describe('isNewerVersion', () => {
  it('compares semver triples, ignoring a leading v', () => {
    expect(isNewerVersion('v1.2.0', '1.1.9')).toBe(true)
    expect(isNewerVersion('1.0.1', '1.0.0')).toBe(true)
    expect(isNewerVersion('1.2.0', '1.2.0')).toBe(false)
    expect(isNewerVersion('0.9.9', '1.0.0')).toBe(false)
  })

  it('rejects non-semver tags', () => {
    expect(isNewerVersion('nightly', '1.0.0')).toBe(false)
  })
})

describe('checkForUpdate', () => {
  it('reports an available update with its release url and apk asset', async () => {
    stubReleases({
      tag_name: 'v99.0.0',
      html_url: 'https://example.com/rel',
      assets: [
        { name: 'notes.txt', browser_download_url: 'https://example.com/notes' },
        { name: 'vihko-v99.0.0.apk', browser_download_url: 'https://example.com/vihko.apk' },
      ],
    })
    expect(await checkForUpdate()).toBe('available')
    expect(update.latest).toBe('99.0.0')
    expect(update.url).toBe('https://example.com/rel')
    expect(update.apkUrl).toBe('https://example.com/vihko.apk')
  })

  it('reports up-to-date when the latest release is not newer', async () => {
    stubReleases({ tag_name: `v${appVersion}`, html_url: 'u' })
    expect(await checkForUpdate()).toBe('uptodate')
  })

  it('treats no published releases (404) as up-to-date', async () => {
    stubReleases({}, 404)
    expect(await checkForUpdate()).toBe('uptodate')
  })

  it('reports errors for failed responses and network failures', async () => {
    stubReleases({}, 500)
    expect(await checkForUpdate()).toBe('error')

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    update.status = 'idle'
    expect(await checkForUpdate()).toBe('error')
  })
})

describe('downloadUpdate', () => {
  beforeEach(() => {
    update.latest = '9.9.9'
    update.url = 'https://example.com/rel'
    update.apkUrl = 'https://example.com/vihko.apk'
  })

  it('opens the release page on the web', async () => {
    const open = vi.fn()
    vi.stubGlobal('open', open)
    await downloadUpdate()
    expect(open).toHaveBeenCalledWith('https://example.com/rel', '_blank', 'noopener')
    expect(native.downloadFile).not.toHaveBeenCalled()
    expect(native.install).not.toHaveBeenCalled()
  })

  it('falls back to the release page when the release has no apk asset', async () => {
    goAndroid()
    update.apkUrl = ''
    const open = vi.fn()
    vi.stubGlobal('open', open)
    await downloadUpdate()
    expect(open).toHaveBeenCalledWith('https://example.com/rel', '_blank', 'noopener')
    expect(native.downloadFile).not.toHaveBeenCalled()
  })

  it('downloads the apk to cache and fires the installer on Android', async () => {
    goAndroid()
    await downloadUpdate()
    expect(native.downloadFile).toHaveBeenCalledWith({
      url: 'https://example.com/vihko.apk',
      path: 'updates/vihko-9.9.9.apk',
      directory: 'CACHE',
      progress: true,
      recursive: true,
    })
    expect(native.install).toHaveBeenCalledWith({ path: '/cache/updates/vihko-9.9.9.apk' })
    expect(update.dl).toBe('ready')
    expect(native.notifyComplete).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/cache/updates/vihko-9.9.9.apk' }),
    )
  })

  it('mirrors download progress into a notification', async () => {
    goAndroid()
    await downloadUpdate()
    native.progressCb?.({ bytes: 50, contentLength: 100 })
    expect(native.notifyProgress).toHaveBeenCalledWith(
      expect.objectContaining({ percent: 50 }),
    )
    expect(update.progress).toBe(50)
  })

  it('ignores a second tap while a download is in flight', async () => {
    goAndroid()
    let finish!: () => void
    native.downloadFile.mockReturnValueOnce(
      new Promise<Record<string, never>>((res) => { finish = () => res({}) }),
    )
    const first = downloadUpdate()
    expect(update.dl).toBe('downloading')
    await downloadUpdate()
    expect(native.downloadFile).toHaveBeenCalledTimes(1)
    finish()
    await first
  })

  it('marks the download as failed on errors', async () => {
    goAndroid()
    native.downloadFile.mockRejectedValueOnce(new Error('net'))
    await downloadUpdate()
    expect(update.dl).toBe('error')
    expect(update.apkPath).toBe('')
    expect(native.install).not.toHaveBeenCalled()
    expect(native.notifyFailed).toHaveBeenCalled()
  })

  it('re-runs the installer without re-downloading once the apk is ready', async () => {
    goAndroid()
    update.apkPath = '/cache/updates/vihko-9.9.9.apk'
    update.dl = 'ready'
    await downloadUpdate()
    expect(native.downloadFile).not.toHaveBeenCalled()
    expect(native.install).toHaveBeenCalledWith({ path: '/cache/updates/vihko-9.9.9.apk' })
  })
})
