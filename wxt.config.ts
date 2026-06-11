import { defineConfig } from 'wxt'
import preact from '@preact/preset-vite'
import tailwindcss from '@tailwindcss/vite'

// https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  outDirTemplate: '.',
  manifest: {
    name: 'X Media Downloader',
    description:
      'Download X (Twitter) tweet/thread media at original quality. Minimalist, local-only, no scraping.',
    permissions: ['downloads', 'storage', 'activeTab'],
    host_permissions: ['https://x.com/*', 'https://twitter.com/*'],
    // Requested at runtime only when Download Strategy = Fetched (ADR-0003):
    optional_permissions: ['offscreen'],
    // twimg CDN = Fetched (ADR-0003); localhost = aria2 JSON-RPC opt-in (ADR-0006).
    optional_host_permissions: [
      'https://pbs.twimg.com/*',
      'https://video.twimg.com/*',
      'http://localhost/*',
    ],
  },
  vite: () => ({
    plugins: [preact(), tailwindcss()],
  }),
})
