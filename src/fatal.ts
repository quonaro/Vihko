import { i18n } from './i18n'

export function showFatalError(root: HTMLElement) {
  const t = i18n.global.t
  root.innerHTML = `
    <div class="fatal">
      <svg class="fatal-icon" viewBox="0 0 48 48" aria-hidden="true">
        <path
          d="M24 7 4.5 41h39L24 7z"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linejoin="round"
        />
        <path d="M24 19v10" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />
        <circle cx="24" cy="35" r="1.5" fill="currentColor" />
      </svg>
      <div class="fatal-title">${t('fatal.title')}</div>
      <div class="fatal-hint">${t('fatal.hint')}</div>
    </div>`
}
