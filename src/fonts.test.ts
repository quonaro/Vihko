import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  customFonts,
  importFontFile,
  initFonts,
  removeCustomFont,
  resetFontsForTests,
  resolveFontFamily,
} from './fonts'

const FONT_ROW_KEY = 'vihko:app:fonts'

const fontFile = (name = 'Inter.ttf', bytes = [0, 1, 2, 3, 250]) =>
  new File([new Uint8Array(bytes)], name, { type: 'font/ttf' })

const readRow = (): { id: string; name: string; family: string; src: string }[] =>
  JSON.parse(localStorage.getItem(FONT_ROW_KEY) ?? '[]')

beforeEach(() => {
  localStorage.clear()
  resetFontsForTests()
})

describe('custom fonts', () => {
  it('imports a font file, registers metadata and persists it', async () => {
    const font = await importFontFile(fontFile())
    expect(font.name).toBe('Inter')
    expect(font.family).toMatch(/^VihkoFont-/)
    expect(font.src.startsWith('data:font/ttf;base64,')).toBe(true)
    // The base64 payload must round-trip the original bytes.
    const payload = font.src.split(',')[1]
    expect([...atob(payload)].map((c) => c.charCodeAt(0))).toEqual([0, 1, 2, 3, 250])
    expect(customFonts).toHaveLength(1)
    expect(readRow()).toHaveLength(1)
    expect(readRow()[0]).toMatchObject({ id: font.id, name: 'Inter' })
  })

  it('reloads the library and resolves imported ids to their family', async () => {
    const font = await importFontFile(fontFile('Handwriting.otf'))
    resetFontsForTests()
    expect(customFonts).toHaveLength(0)

    await initFonts()
    expect(customFonts).toHaveLength(1)
    expect(customFonts[0].id).toBe(font.id)
    expect(resolveFontFamily(font.id)).toContain(font.family)
  })

  it('falls back to the sans stack for unknown or removed fonts', async () => {
    const sans = resolveFontFamily('sans')
    expect(resolveFontFamily('nope')).toBe(sans)
    const font = await importFontFile(fontFile())
    await removeCustomFont(font.id)
    expect(customFonts).toHaveLength(0)
    expect(readRow()).toHaveLength(0)
    expect(resolveFontFamily(font.id)).toBe(sans)
  })

  it('suffixes duplicate display names but keeps ids and families unique', async () => {
    const a = await importFontFile(fontFile('Inter.ttf'))
    const b = await importFontFile(fontFile('Inter.woff2'))
    expect(a.name).toBe('Inter')
    expect(b.name).toBe('Inter 2')
    expect(a.id).not.toBe(b.id)
    expect(a.family).not.toBe(b.family)
  })

  it('rejects unsupported and oversized files', async () => {
    await expect(importFontFile(fontFile('notes.txt'))).rejects.toThrow('unsupported-font-format')
    const huge = {
      name: 'huge.ttf',
      size: 32 * 1024 * 1024,
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as File
    await expect(importFontFile(huge)).rejects.toThrow('font-too-large')
    expect(customFonts).toHaveLength(0)
  })

  it('ignores a corrupt stored row instead of failing boot', async () => {
    localStorage.setItem(FONT_ROW_KEY, '{not json')
    await initFonts()
    expect(customFonts).toHaveLength(0)
  })

  it('keeps the font for the session when storage rejects the save', async () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded')
    })
    await expect(importFontFile(fontFile())).rejects.toThrow('font-save-failed')
    spy.mockRestore()
    expect(customFonts).toHaveLength(1)
    expect(resolveFontFamily(customFonts[0].id)).toContain(customFonts[0].family)
  })
})
