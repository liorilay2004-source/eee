import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type Plugin } from 'vite'

/**
 * Stamps a per-build id into dist/sw.js (replacing __BUILD_ID__), so each deploy changes the service worker's
 * cache name and bytes: browsers install the new worker and it deletes the old caches on activate.
 * The id is a hash of the emitted bundle file names (which are content hashed) plus the build time.
 */
function stampServiceWorker(): Plugin {
  let outDir = 'dist'
  let names: string[] = []
  return {
    name: 'stamp-service-worker',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    generateBundle(_options, bundle) {
      names = Object.keys(bundle).sort()
    },
    closeBundle() {
      const file = resolve(outDir, 'sw.js')
      if (!existsSync(file)) return
      const id = createHash('sha256').update(names.join('\n')).update(String(Date.now())).digest('hex').slice(0, 12)
      const source = readFileSync(file, 'utf8')
      if (!source.includes('__BUILD_ID__')) throw new Error('sw.js has no __BUILD_ID__ placeholder')
      writeFileSync(file, source.replaceAll('__BUILD_ID__', id))
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), stampServiceWorker()],
  server: {
    proxy: {
      '/api': {
        target: 'https://eee-api.liorilay2004.workers.dev',
        changeOrigin: true,
        secure: true,
      },
    },
  },
})
