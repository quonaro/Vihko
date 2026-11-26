import { reactive } from 'vue'
import { logger } from '../log'

const log = logger('text-input')

// Shared state for the text tool dialog. A single instance lives at the app
// level so the canvas can await a placement and re-render afterwards (same
// pattern as usePrompt).
interface TextInputState {
  open: boolean
  value: string
}

const state = reactive<TextInputState>({ open: false, value: '' })

let resolver: ((value: string | null) => void) | null = null

export function useTextInput() {
  function askText(value = ''): Promise<string | null> {
    resolver?.(null)
    log.debug('text dialog opened')
    Object.assign(state, { open: true, value })
    return new Promise<string | null>((resolve) => {
      resolver = resolve
    })
  }

  function settle(result: string | null) {
    state.open = false
    resolver?.(result)
    resolver = null
  }

  return { state, askText, settle }
}
