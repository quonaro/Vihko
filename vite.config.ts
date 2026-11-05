/// <reference types="vitest/config" />
import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
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

// Browser logger bridge: src/log.ts beacons entries here in dev so they
// show up in the terminal next to vite's own output (handy on-device too —
// the WebView's console is otherwise only reachable via remote debugging).
const terminalLogs: Plugin = {
  name: 'vihko-terminal-logs',
  configureServer(server) {
    server.middlewares.use('/__vihko-log', (req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        res.statusCode = 204
        res.end()
        try {
          const { level, ns, args } = JSON.parse(body) as {
            level: string
            ns: string
            args: string[]
          }
          const line = `[web] [${ns}] ${args.join(' ')}`
          if (level === 'error') console.error(line)
          else if (level === 'warn') console.warn(line)
          else console.log(line)
        } catch {
          /* malformed log body — ignore */
        }
      })
    })
  },
}

export default defineConfig({
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(appVersion),
  },
  plugins: [vueDevTools(), vue(), terminalLogs],
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
