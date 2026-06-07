import { defineConfig } from 'wxt'
import preact from '@preact/preset-vite'
import tailwindcss from '@tailwindcss/vite'

// https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  manifest: {
    name: 'X Media Downloader',
    description:
      'Download X (Twitter) tweet/thread media at original quality. Minimalist, local-only, no scraping.',
    permissions: ['downloads', 'storage'],
    host_permissions: [
      'https://x.com/*',
      'https://twitter.com/*',
      'https://pbs.twimg.com/*',
      'https://video.twimg.com/*',
    ],
  },
  vite: () => ({
    plugins: [preact(), tailwindcss()],
  }),
})
