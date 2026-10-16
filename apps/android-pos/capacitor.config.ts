import type { CapacitorConfig } from '@capacitor/cli'
const config: CapacitorConfig = {
  appId: 'info.internext.pos',
  appName: 'Internext POS',
  webDir: 'dist',
  loggingBehavior: 'none',
  android: { allowMixedContent: false, webContentsDebuggingEnabled: false },
  server: { hostname: 'localhost', androidScheme: 'https', cleartext: false },
}
export default config
