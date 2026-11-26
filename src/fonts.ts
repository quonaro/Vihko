import { reactive } from 'vue'
import type { CustomFont, TextFont } from './types'
import { logger } from './log'
import { readAppRow, writeAppRow } from './persistence'

const log = logger('fonts')

// Imported fonts live in the app_state KV (SQLite on native, IndexedDB in the
// browser) as one JSON row of base64 dataURLs, so the whole library travels
// with the app data and works offline. Faces are registered with the CSS Font
// Loading API at boot — canvas text (editor, layer rasters, 3D thumbnails,
// exports) then draws with them through the normal `ctx.font` path.

const ROW_KEY = 'fonts'
const MAX_FONT_BYTES = 16 * 1024 * 1024

const MIME: Record<string, string> = {
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
}

// Built-in font keys and their concrete stacks. The hand stack degrades
// gracefully on platforms where the nicer scripts are missing.
const FONT_STACKS: Record<TextFont, string> = {
  sans: "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  serif: "Georgia, 'Times New Roman', Times, serif",
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  hand: "'Segoe Script', 'Bradley Hand', 'Noteworthy', 'Comic Sans MS', cursive",
}

export const customFonts = reactive<CustomFont[]>([])

const activeFaces = new Map<string, FontFace>()
const listeners = new Set<() => void>()
let loadPromise: Promise<void> | null = null

// Fires after a face is registered (or removed) so open canvases can drop
// cached text rasters and repaint.
export function onFontsChanged(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function notify() {
  for (const fn of listeners) fn()
}

export function customFontById(id: string | undefined): CustomFont | undefined {
  return id ? customFonts.find((f) => f.id === id) : undefined
}

// CSS font-family stack for a text item: a built-in key, an imported font id,
// or the sans fallback for a font that was removed/unreadable.
export function resolveFontFamily(font: string | undefined): string {
  if (!font) return FONT_STACKS.sans
  const builtin = FONT_STACKS[font as TextFont]
  if (builtin) return builtin
  const custom = customFontById(font)
  return custom ? `${custom.family}, ${FONT_STACKS.sans}` : FONT_STACKS.sans
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10)
}

function extensionOf(name: string): string | null {
  const match = /\.([a-z0-9]+)$/i.exec(name)
  const ext = match?.[1].toLowerCase()
  return ext && ext in MIME ? ext : null
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  // Chunked to stay clear of the argument-count limit on large fonts.
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

// Registers the CSS face. Throws when the browser refuses the font; without a
// Font Loading API (jsdom, locked-down WebViews) the font is kept as metadata
// and renders with the fallback stack.
async function activate(font: CustomFont): Promise<void> {
  if (activeFaces.has(font.id)) return
  if (typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts) {
    log.debug('FontFace API unavailable, keeping font metadata only', font.name)
    return
  }
  const face = new FontFace(font.family, `url(${font.src})`)
  await face.load()
  document.fonts.add(face)
  activeFaces.set(font.id, face)
  log.debug('font face registered', { name: font.name, family: font.family })
}

async function persist(): Promise<void> {
  const rows = customFonts.map(({ id, name, family, src }) => ({ id, name, family, src }))
  await writeAppRow(ROW_KEY, JSON.stringify(rows))
}

// Loads the stored library and registers every face. Awaited before the Vue
// app mounts, so the first text paint already has the real fonts.
export function initFonts(): Promise<void> {
  loadPromise ??= (async () => {
    let raw: string | undefined
    try {
      raw = await readAppRow(ROW_KEY)
    } catch (e) {
      log.warn('font library read failed', e)
      return
    }
    if (!raw) return
    let list: unknown
    try {
      list = JSON.parse(raw)
    } catch {
      log.warn('font library row is not valid json')
      return
    }
    if (!Array.isArray(list)) return
    for (const row of list as CustomFont[]) {
      if (!row?.id || !row.src || !row.family) continue
      const font: CustomFont = {
        id: row.id,
        name: row.name || 'Font',
        family: row.family,
        src: row.src,
      }
      customFonts.push(font)
      try {
        await activate(font)
      } catch (e) {
        log.warn('stored font failed to load', font.name, e)
      }
    }
    log.info('custom fonts loaded', customFonts.length)
    notify()
  })()
  return loadPromise
}

// Imports one font file: validates it, registers the face and appends it to
// the library. The caller picks the new font for the next text block.
export async function importFontFile(file: File): Promise<CustomFont> {
  const ext = extensionOf(file.name)
  if (!ext) {
    log.warn('font import rejected: unsupported format', file.name)
    throw new Error('unsupported-font-format')
  }
  if (file.size > MAX_FONT_BYTES) {
    log.warn('font import rejected: too large', file.name, file.size)
    throw new Error('font-too-large')
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (!bytes.length) throw new Error('empty-font-file')
  const id = uid()
  const base = file.name.replace(/\.[^.]+$/, '').trim() || 'Font'
  // A name collision is harmless (ids differ), but duplicated labels are
  // confusing — suffix the second "Inter" as "Inter 2".
  let name = base
  for (let n = 2; customFonts.some((f) => f.name === name); n++) name = `${base} ${n}`
  const font: CustomFont = {
    id,
    name,
    family: `VihkoFont-${id}`,
    src: `data:${MIME[ext]};base64,${toBase64(bytes)}`,
  }
  await activate(font)
  customFonts.push(font)
  notify()
  try {
    await persist()
  } catch (e) {
    // Keep the font usable for this session — deleting it would be worse when
    // storage is only temporarily unavailable — but tell the caller it won't
    // survive a restart.
    log.warn('font could not be persisted', font.name, e)
    throw new Error('font-save-failed')
  }
  log.info('font imported', { name, bytes: bytes.length })
  return font
}

export async function removeCustomFont(id: string): Promise<boolean> {
  const index = customFonts.findIndex((f) => f.id === id)
  if (index < 0) return false
  const [font] = customFonts.splice(index, 1)
  const face = activeFaces.get(id)
  if (face && typeof document !== 'undefined' && document.fonts) document.fonts.delete(face)
  activeFaces.delete(id)
  try {
    await persist()
  } catch (e) {
    log.warn('font removal could not be persisted', font.name, e)
  }
  log.info('font removed', font.name)
  notify()
  return true
}

// Test seam: forget loaded faces/metadata without touching storage.
export function resetFontsForTests() {
  customFonts.splice(0, customFonts.length)
  activeFaces.clear()
  loadPromise = null
  listeners.clear()
}
