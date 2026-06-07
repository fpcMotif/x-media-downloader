export default defineContentScript({
  matches: ['*://x.com/*', '*://twitter.com/*'],
  main() {
    // Overlays wired in task 010.
  },
})
