import { createApp } from 'vue'
import App from './App.vue'
import { disableBrowserContextMenu } from './contextMenu'
import { showFatalError } from './fatal'
import { i18n } from './i18n'
import { initInk } from './ink/engine'
import { logger } from './log'
import { initRouter } from './router'
import { initializeStorePersistence } from './store'
import { requestStartupPermissions } from './update'
import './style.css'

const log = logger('app')

async function start() {
  log.info('app starting')
  try {
    disableBrowserContextMenu()
    await initializeStorePersistence()
    initRouter()
    void initInk()
    createApp(App).use(i18n).mount('#app')
    void requestStartupPermissions()
    log.info('app mounted')
  } catch (error) {
    log.error('Could not initialize local storage', error)
    const root = document.querySelector<HTMLElement>('#app')
    if (root) showFatalError(root)
  }
}

void start()
