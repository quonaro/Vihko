import { describe, it, expect, vi, beforeEach } from 'vitest'
import { saveFile } from './saveFile'

const mocks = vi.hoisted(() => ({
  isNative: vi.fn(() => false),
  writeFile: vi.fn(async () => ({ uri: 'file:///w' })),
  getUri: vi.fn(async () => ({ uri: 'file:///cache/exports/a.png' })),
  share: vi.fn(async () => ({})),
}))

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: mocks.isNative },
}))
vi.mock('@capacitor/filesystem', () => ({
  Directory: { Cache: 'CACHE' },
  Filesystem: { writeFile: mocks.writeFile, getUri: mocks.getUri },
}))
vi.mock('@capacitor/share', () => ({ Share: { share: mocks.share } }))

describe('saveFile', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isNative.mockReturnValue(false)
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: vi.fn(() => 'blob:fake'),
        revokeObjectURL: vi.fn(),
      }),
    )
  })

  it('downloads via an anchor on the web', async () => {
    let clicked: HTMLAnchorElement | null = null
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked = this
    })
    await saveFile('page-1.png', new Blob(['png']))
    expect(clicked).not.toBeNull()
    expect(clicked!.download).toBe('page-1.png')
    expect(clicked!.href).toBe('blob:fake')
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it('writes to cache and opens the share sheet on native', async () => {
    mocks.isNative.mockReturnValue(true)
    const blob = new Blob(['png'])
    await saveFile('a.png', blob)
    expect(mocks.writeFile).toHaveBeenCalledWith({
      path: 'exports/a.png',
      data: blob,
      directory: 'CACHE',
      recursive: true,
    })
    expect(mocks.share).toHaveBeenCalledWith({
      url: 'file:///cache/exports/a.png',
      title: 'a.png',
    })
  })
})
