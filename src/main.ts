import { createApp } from 'vue'
import App from './App.vue'
import { disableBrowserContextMenu } from './contextMenu'
import { i18n } from './i18n'
import { initInk } from './ink/engine'
import { initRouter } from './router'
import { initializeStorePersistence } from './store'
import { requestStartupPermissions } from './update'
import './style.css'

async function start() {
  try {
    disableBrowserContextMenu()
    await initializeStorePersistence()
    initRouter()
    void initInk()
    createApp(App).use(i18n).mount('#app')
    void requestStartupPermissions()
  } catch (error) {
    console.error('Could not initialize local storage', error)
    const root = document.querySelector('#app')
    if (root)
      root.textContent = 'Не удалось открыть локальную базу данных. Данные не были изменены.'
  }
}

void start()
