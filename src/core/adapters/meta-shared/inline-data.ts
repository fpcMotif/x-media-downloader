/**
 * Extracts candidate server-embedded data payloads from a page's inline
 * `<script>` tags — the cold-navigation counterpart to the MAIN-world
 * XHR/fetch tee (`inject.content.ts`). LIVE-VERIFIED 2026-07-06 (real
 * https://www.instagram.com/reels/DaH4la4pRtC/ session): on a cold direct
 * navigation to a reel, the FIRST reel's data never crosses XHR/fetch at
 * all — it arrives server-rendered inside an inline
 * `<script type="application/json">` holding a RelayPrefetchedStreamCache
 * preloader payload. The tee structurally cannot see it (nothing is
 * fetched), so this module is a second, independent way to feed the exact
 * same detection pipeline (`forEachPostNode` / `detectMediaItems`) — see
 * `post-node.ts`'s doc comment: that walker recurses into arbitrary
 * nesting with no wrapper-key assumptions, so a raw inline payload works
 * through it completely untouched, no platform knowledge needed here.
 *
 * Deliberately dumb and total: no JSON.parse (the existing
 * `xmd:media-response` consumer already try/parses — see
 * overlay.content/index.tsx:1658-1663), no filtering by payload shape or
 * platform. Just "which scripts are worth handing to that parser".
 */

export interface ScriptLike {
  readonly type: string
  readonly textContent: string | null
}

/**
 * The `textContent` of every `<script type="application/json">` in `scripts`
 * with non-empty content, in document order. Takes an ArrayLike/Iterable so
 * `document.scripts` (an `HTMLCollectionOf<HTMLScriptElement>`, not a real
 * array) can be passed directly without a caller-side `Array.from`.
 */
export function inlineDataPayloads(scripts: ArrayLike<ScriptLike>): string[] {
  const out: string[] = []
  for (let i = 0; i < scripts.length; i++) {
    const script = scripts[i] as ScriptLike
    if (script.type !== 'application/json') continue
    if (!script.textContent) continue
    out.push(script.textContent)
  }
  return out
}
