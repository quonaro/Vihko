import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { appVersion, update, checkForUpdate, isNewerVersion } from './update'

const stubReleases = (body: unknown, status = 200) =>
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response)))

beforeEach(() => {
  update.status = 'idle'
  update.busy = false
  update.latest = ''
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
  it('reports an available update with its release url', async () => {
    stubReleases({ tag_name: 'v99.0.0', html_url: 'https://example.com/rel' })
    expect(await checkForUpdate()).toBe('available')
    expect(update.latest).toBe('99.0.0')
    expect(update.url).toBe('https://example.com/rel')
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
