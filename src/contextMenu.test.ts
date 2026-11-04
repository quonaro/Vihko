import { describe, expect, it } from 'vitest'
import { disableBrowserContextMenu } from './contextMenu'

describe('disableBrowserContextMenu', () => {
  it('prevents the native context menu on any element', () => {
    const removeListener = disableBrowserContextMenu()
    const image = document.createElement('img')
    document.body.append(image)

    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    image.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)

    removeListener()
    image.remove()
  })

  it('removes its listener when disposed', () => {
    const removeListener = disableBrowserContextMenu()
    removeListener()

    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    document.body.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(false)
  })
})
