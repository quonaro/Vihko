import { createApp } from 'vue'
import App from './App.vue'
import { i18n } from './i18n'
import { initInk } from './ink/engine'
import { initializeStorePersistence } from './store'
import './style.css'

async function start() {
  try {
    await initializeStorePersistence()
    void initInk()
    createApp(App).use(i18n).mount('#app')
  } catch (error) {
    console.error('Could not initialize local storage', error)
    const root = document.querySelector('#app')
    if (root) root.textContent = 'Не удалось открыть локальную базу данных. Данные не были изменены.'
  }
}

void start()
