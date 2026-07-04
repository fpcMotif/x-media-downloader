import { readFileSync } from 'node:fs'
import { defineConfig } from 'wxt'
import preact from '@preact/preset-vite'
import tailwindcss from '@tailwindcss/vite'

// When a local `.env` pre-seeds Cloud Sync (WXT_CONVEX_URL), promote the Convex
// origin from an optional to a REQUIRED host permission for THIS build only —
// unpacked dev extensions get required host permissions auto-granted on reload,
// so the seeded config works with zero clicks. A normal build (no `.env`) keeps
// it optional and opt-in (ADR-0009).
const seedsConvex = (() => {
  try {
    return /^\s*WXT_CONVEX_URL=\S/m.test(readFileSync('.env', 'utf8'))
  } catch {
    return false
  }
})()

const CONVEX_ORIGIN = 'https://*.convex.cloud/*'

// https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  manifest: {
    name: 'X Media Downloader',
    description:
      'Download X (Twitter) tweet/thread media at original quality. Minimalist, local-only, no scraping.',
    // `identity` powers chrome.identity.launchWebAuthFlow for Cloud Upload OAuth
    // (ADR-0013). Required (not optional): `identity` is not reliably grantable
    // via chrome.permissions.request. launchWebAuthFlow needs no host permission
    // for the auth window or the chromiumapp.org redirect.
    // `alarms` powers the Cloud Upload backoff wake-up (ADR-0013) so failed
    // uploads retry autonomously after the service worker suspends.
    // `unlimitedStorage` keeps the Tweet Harvest IndexedDB store (`xmd-capture`)
    // from being evicted under browser storage pressure — the breadth flag can
    // harvest tens of thousands of text records.
    permissions: ['downloads', 'storage', 'activeTab', 'identity', 'alarms', 'unlimitedStorage'],
    host_permissions: [
      'https://x.com/*',
      'https://twitter.com/*',
      // X's public embed endpoint — the background fetches it to recover a video
      // the passive tee missed (SPA cache hit / lazy reply). Required (not opt-in)
      // so the media count is correct out of the box; read-only, X-owned, narrow.
      'https://cdn.syndication.twimg.com/*',
      // Instagram/Threads page origins (multi-platform adapter abstraction,
      // docs/superpowers/specs/2026-07-04-multi-platform-adapter-design.md) —
      // mirror the X pair above so the content scripts' widened `matches` have
      // a matching host permission. Threads moved `threads.net` → `threads.com`
      // in April 2025; both hosts serve the same backend, so both are listed.
      'https://www.instagram.com/*',
      'https://www.threads.net/*',
      'https://www.threads.com/*',
      ...(seedsConvex ? [CONVEX_ORIGIN] : []),
    ],
    // Requested at runtime only when Download Strategy = Fetched (ADR-0003):
    optional_permissions: ['offscreen'],
    // twimg CDN = Fetched (ADR-0003) AND the Cloud Upload byte source (ADR-0013);
    // localhost = aria2 JSON-RPC opt-in (ADR-0006); convex.cloud = Cloud Sync
    // opt-in (ADR-0009), unless a local `.env` pre-seeds it (then it's required,
    // above); the googleapis/dropboxapi origins = Cloud Upload provider APIs
    // (ADR-0013), requested at provider-connect time.
    optional_host_permissions: [
      'https://pbs.twimg.com/*',
      'https://video.twimg.com/*',
      'http://localhost/*',
      'https://www.googleapis.com/*',
      'https://oauth2.googleapis.com/*',
      'https://api.dropboxapi.com/*',
      'https://content.dropboxapi.com/*',
      'https://www.dropbox.com/*',
      ...(seedsConvex ? [] : [CONVEX_ORIGIN]),
    ],
  },
  vite: () => ({
    plugins: [preact(), tailwindcss()],
  }),
})
