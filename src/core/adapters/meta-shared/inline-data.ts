import { MAX_TEE_BODY_BYTES } from '../../tee-contract'
import { utf8ByteLengthAtMost } from '../../wire/utf8'

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

/** One cold-navigation intake may retain at most one tee body's worth of JSON. */
export const MAX_INLINE_DATA_BYTES = MAX_TEE_BODY_BYTES

/** Real pages need a few preloaders. This leaves headroom without unbounded fan-out. */
export const MAX_INLINE_DATA_SCRIPTS = 64

/** Maximum script elements examined during the one-shot cold-navigation scan. */
export const MAX_INLINE_DOCUMENT_SCRIPTS = 4_096

/**
 * The `textContent` of every `<script type="application/json">` in `scripts`
 * with non-empty content, in document order. Takes an ArrayLike/Iterable so
 * `document.scripts` (an `HTMLCollectionOf<HTMLScriptElement>`, not a real
 * array) can be passed directly without a caller-side `Array.from`.
 *
 * Admission is atomic. If candidate count or aggregate UTF-8 bytes exceed the
 * page budget, no payload is returned and therefore none can reach JSON.parse.
 */
export function inlineDataPayloads(scripts: ArrayLike<ScriptLike>): string[] {
  const out: string[] = []
  let candidateScripts = 0
  let retainedBytes = 0
  try {
    const scriptCount = scripts.length
    if (
      !Number.isSafeInteger(scriptCount) ||
      scriptCount < 0 ||
      scriptCount > MAX_INLINE_DOCUMENT_SCRIPTS
    )
      return []
    for (let i = 0; i < scriptCount; i++) {
      const script = scripts[i] as ScriptLike
      const type = script.type
      if (type !== 'application/json') continue
      const body = script.textContent
      candidateScripts += 1
      if (candidateScripts > MAX_INLINE_DATA_SCRIPTS) return []
      if (!body) continue
      const bytes = utf8ByteLengthAtMost(body, MAX_INLINE_DATA_BYTES - retainedBytes)
      if (bytes === undefined) return []
      retainedBytes += bytes
      out.push(body)
    }
  } catch {
    return []
  }
  return out
}
