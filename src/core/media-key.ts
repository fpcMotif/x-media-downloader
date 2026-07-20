/** ADR-0016's identity rule, in one place: the URL's final path segment minus its final
 *  extension, query/fragment stripped. Works on full URLs AND bare pathnames (string ops,
 *  no URL parse — callers that need a host gate apply it BEFORE delegating). Null when
 *  the segment is empty — never an '' identity. */
export function mediaBasenameKey(urlOrPath: string): string | null {
  const hash = urlOrPath.indexOf('#')
  const noFragment = hash >= 0 ? urlOrPath.slice(0, hash) : urlOrPath
  const query = noFragment.indexOf('?')
  const path = query >= 0 ? noFragment.slice(0, query) : noFragment
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  const key = dot >= 0 ? base.slice(0, dot) : base
  return key.length > 0 ? key : null
}
