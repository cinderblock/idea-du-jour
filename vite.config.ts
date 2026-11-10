import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nitro } from 'nitro/vite'

export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    nitro({
      // @simplewebauthn/server stays a real node_modules import: bundled, its
      // `import 'reflect-metadata'` is lost and tsyringe (via @peculiar/x509,
      // since v14) throws on every request. The image ships prod node_modules.
      rollupConfig: { external: [/^@sentry\//, /^@simplewebauthn\/server/] },
      plugins: ['./src/server/plugins/workers.ts'],
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})
