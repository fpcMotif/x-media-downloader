# Reverse-Engineering Social Media SPAs — Resources

## Knowledge

- [Chrome DevTools: Network panel](https://developer.chrome.com/docs/devtools/network) — official docs
  How to filter to Fetch/XHR, read the Preview/Response/Payload tabs, pretty-print minified JSON. Use for: the "watch the network" half of finding a site's data.
- [Inspecting network JSON payloads with browser DevTools](https://offlinetools.org/a/json-formatter/inspecting-network-json-payloads-with-browser-devtools) — walkthrough
  More hands-on than the official docs; covers searching within a response and the Replay-XHR trick. Use for: a first pass when you don't know what endpoint carries the data yet.
- [Relay GitHub issue #1881 — preloaded records / QueryRenderer hydration](https://github.com/facebook/relay/issues/1881) and [Apollo Client: Server-Side Rendering](https://www.apollographql.com/docs/react/performance/server-side-rendering) — official/semi-official docs on the *other* half
  Explains WHY sites embed a JSON blob in a `<script type="application/json">` tag on first load (avoid a loading spinner, keep client/server state in sync) — this is what Instagram/Threads' `data-sjs` scripts are doing. Use for: understanding embedded-JSON hydration is a known, common pattern, not a quirk of one site.
- ["A Recursive Descent (Recreating JSON.parse)"](https://dev.to/wpreble1/a-recursive-descent-recreating-json-parse-1icb) — dev.to walkthrough
  Concrete, code-along introduction to recursive/structural tree walking. Use for: the mechanics of writing a function that visits every node of an unknown-shaped tree, which is the actual muscle behind "the key trick."
- [Is Web Scraping Legal? Navigating ToS and Best Practices (Ethical Web Data Collection Initiative)](https://ethicalwebdata.com/2025/01/27/is-web-scraping-legal-navigating-terms-of-service-and-best-practices/) — practitioner-oriented legal/ethics overview
  Covers clickwrap vs browsewrap ToS, the *hiQ v. LinkedIn* public-data precedent, and "good citizen" practices (respect `robots.txt`, rate-limit, minimize data collected). Use for: staying on the right side of the personal-use line — this project is read-only, own-session, no redistribution, which is the safest posture described here.

- [How to Scrape Hidden APIs (ScrapFly)](https://scrapfly.io/blog/posts/how-to-scrape-hidden-apis) — practical walkthrough
  End-to-end hands-on workflow: trigger the action → filter Network to XHR/Fetch → identify the JSON-returning request → inspect headers/payload → "Copy as cURL" to replicate outside the browser. Use for: the concrete step-by-step when hunting for a specific unfamiliar endpoint (Lesson 2).

## Gaps

- No source found yet specifically on *DOM-only* extraction (matching a rendered `<img>`/`<video>` element back to a data-model identity via URL-shape conventions like CDN path families). This was learned empirically this session (live DevTools inspection), not from a written resource — worth writing up as your own reference material once it's solid (see `reference/`).
- No dedicated resource yet on GraphQL persisted-query/`doc_id` dispatch specifically (why a request body carries an opaque id instead of a query string). Revisit if a future platform needs this decoded rather than just detected by shape.

## Wisdom (Communities)

- [r/webscraping](https://reddit.com/r/webscraping) — active, practitioner-heavy, good for "is this endpoint/pattern still working" style questions and general technique discussion.
- No in-person/local community identified for this niche topic — revisit if useful.
