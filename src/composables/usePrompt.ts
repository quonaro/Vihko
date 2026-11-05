import { reactive } from 'vue'
import { i18n } from '../i18n'
import { logger } from '../log'

const log = logger('prompt')

export interface PromptOptions {
  title: string
  description?: string
  value?: string
  placeholder?: string
  confirmText?: string
  cancelText?: string
  inputMode?: 'text' | 'numeric' | 'decimal'
}

interface PromptState {
  open: boolean
  title: string
  description: string
  value: string
  placeholder: string
  confirmText: string
  cancelText: string
  inputMode: 'text' | 'numeric' | 'decimal'
}

const state = reactive<PromptState>({
  open: false,
  title: '',
  description: '',
  value: '',
  placeholder: '',
  confirmText: '',
  cancelText: '',
  inputMode: 'text',
})

let resolver: ((value: string | null) => void) | null = null

export function usePrompt() {
  function prompt(options: PromptOptions): Promise<string | null> {
    resolver?.(null)
    log.debug('prompt opened', options.title)
    const t = i18n.global.t
    Object.assign(state, {
      open: true,
      title: options.title,
      description: options.description ?? '',
      value: options.value ?? '',
      placeholder: options.placeholder ?? '',
      confirmText: options.confirmText ?? t('dlg.save'),
      cancelText: options.cancelText ?? t('dlg.cancel'),
      inputMode: options.inputMode ?? 'text',
    })
    return new Promise<string | null>((resolve) => {
      resolver = resolve
    })
  }

  function settle(result: string | null) {
    state.open = false
    resolver?.(result)
    resolver = null
  }

  return { state, prompt, settle }
}
