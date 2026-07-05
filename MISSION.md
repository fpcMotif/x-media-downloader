# Mission: Reverse-engineering social media SPAs for media extraction

## Why
You're maintaining xediadownloader (a browser extension downloading media from X/Instagram/Threads). When a platform changes its API shape or DOM structure, you want to diagnose and fix the detection code yourself — not depend on a live debugging session each time.

## Success looks like
- Given a new/broken platform, you can open DevTools, find the embedded data blob or network call yourself
- You can write a structural (shape-based) parser instead of a brittle hardcoded-path one
- You can explain WHY a hardcoded path breaks and a shape-based walk doesn't

## Constraints
- Learning happens in short sessions alongside active work on the extension — lessons should be quick, not a sit-down course
- Grounded in the real xediadownloader codebase (`src/core/adapters/`) wherever possible, not toy examples

## Out of scope
- General-purpose web scraping infrastructure (proxies, headless browsers, anti-bot evasion) — this mission is about *reading* a site's own data shape, not industrial-scale scraping
- Building new platforms' adapters from scratch (that's project work, done together in the main coding session) — this workspace is about the *technique*, transferable to whichever platform comes next
