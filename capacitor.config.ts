import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'vihko.app',
  appName: 'Vihko',
  webDir: 'dist',
  android: {
    allowMixedContent: false,
  },
  ios: {
    contentInset: 'never',
  },
  plugins: {
    // Insets reach the web layer through MainActivity, which runs edge to edge
    // and forwards them as CSS variables; the plugin must not pad the web view.
    SystemBars: {
      insetsHandling: 'disable',
    },
    CapacitorSQLite: {
      // Defaults to true, which makes the plugin build an AndroidKeyStore
      // MasterKey + EncryptedSharedPreferences at load() — that throws on
      // devices where keystore keygen fails and bricks the whole plugin.
      // We only ever open 'no-encryption' connections, so it's off.
      androidIsEncryption: false,
      iosIsEncryption: false,
    },
  },
}

export default config
