import { afterEach, describe, expect, it, vi } from 'vitest'
import { isDebugEnabled, LOG_FLAG, logger } from './log'

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('isDebugEnabled', () => {
  it('is off when the flag is absent', () => {
    expect(isDebugEnabled('ink')).toBe(false)
  })

  it('enables a listed namespace only', () => {
    localStorage.setItem(LOG_FLAG, 'ink,store')
    expect(isDebugEnabled('ink')).toBe(true)
    expect(isDebugEnabled('store')).toBe(true)
    expect(isDebugEnabled('router')).toBe(false)
  })

  it('* enables everything and -ns excludes', () => {
    localStorage.setItem(LOG_FLAG, '*,-ink')
    expect(isDebugEnabled('store')).toBe(true)
    expect(isDebugEnabled('ink')).toBe(false)
  })
})

describe('logger', () => {
  it('suppresses debug/info unless enabled', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const log = logger('ink')
    log.debug('hidden')
    log.info('hidden')
    expect(debug).not.toHaveBeenCalled()
    expect(info).not.toHaveBeenCalled()
    localStorage.setItem(LOG_FLAG, 'ink')
    log.debug('shown', 42)
    log.info('shown')
    expect(debug).toHaveBeenCalledWith('[ink]', 'shown', 42)
    expect(info).toHaveBeenCalledWith('[ink]', 'shown')
  })

  it('always emits warn and error', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const log = logger('store')
    log.warn('w')
    log.error('e')
    expect(warn).toHaveBeenCalledWith('[store]', 'w')
    expect(error).toHaveBeenCalledWith('[store]', 'e')
  })

  it('beacons emitted entries to the dev-server endpoint', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const beacon = vi.fn().mockReturnValue(true)
    Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true })
    logger('store').warn('hello', { a: 1 })
    expect(beacon).toHaveBeenCalledOnce()
    const [url, blob] = beacon.mock.calls[0] as [string, Blob]
    expect(url).toBe('/__vihko-log')
    expect(blob.type).toBe('application/json')
    Reflect.deleteProperty(navigator, 'sendBeacon')
  })

  it('serializes errors as "Name: message" instead of {}', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const beacon = vi.fn().mockReturnValue(true)
    Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true })
    logger('store').warn('fail', new DOMException('nope', 'QuotaExceededError'))
    const [, blob] = beacon.mock.calls[0] as [string, Blob]
    const payload = JSON.parse(await blob.text()) as { args: string[] }
    expect(payload.args[1]).toBe('QuotaExceededError: nope')
    Reflect.deleteProperty(navigator, 'sendBeacon')
  })
})
