/// <reference types="vitest/config" />
import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'
import pkg from './package.json'

const gitVersion = (args: string): string | null => {
  try {
    return execSync(`git ${args}`, { encoding: 'utf8' }).trim() || null
  } catch {
    return null
  }
}

// Release CI passes VITE_APP_VERSION explicitly; locally fall back to the git
// tag/description so dev builds don't all report package.json's version.
// Under vitest keep package.json — tests must not depend on git state.
const appVersion =
  process.env.VITE_APP_VERSION ||
  (process.env.VITEST ? null : gitVersion('describe --tags --always --dirty')) ||
  pkg.version

export default defineConfig({
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(appVersion),
  },
  plugins: [vueDevTools(), vue()],
  server: {
    host: '0.0.0.0',
    port: 7357,
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test.setup.ts'],
  },
})
