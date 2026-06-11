/**
 * Outbound-link extraction + classification for archived tweets (ADR-0010).
 * Pure: no I/O. Scholarly publishers get a stable `publisher` tag so a saved
 * archive is greppable by source (arXiv, DOI, Springer, …).
 */

export type LinkKind = 'scholarly' | 'other'

export interface ArchivedLink {
  readonly url: string
  readonly kind: LinkKind
  readonly publisher?: string
}

export type LinkMode = 'all' | 'scholarly' | 'none'

/**
 * Publisher → host labels. A host matches a label when it equals the label or
 * is a subdomain of it (whole-label suffix), so `arxiv.org` and
 * `export.arxiv.org` match `arxiv.org` but `notarxiv.org` does not.
 */
const PUBLISHERS: ReadonlyArray<readonly [publisher: string, hosts: ReadonlyArray<string>]> = [
  ['arxiv', ['arxiv.org']],
  ['doi', ['doi.org', 'dx.doi.org']],
  ['springer', ['springer.com', 'link.springer.com', 'springernature.com']],
  ['cambridge', ['cambridge.org']],
  ['oup', ['oup.com', 'academic.oup.com']],
  ['nature', ['nature.com']],
  ['science', ['science.org']],
  ['elsevier', ['sciencedirect.com', 'elsevier.com']],
  ['wiley', ['wiley.com', 'onlinelibrary.wiley.com']],
  ['ieee', ['ieee.org', 'ieeexplore.ieee.org']],
  ['acm', ['acm.org', 'dl.acm.org']],
  ['jstor', ['jstor.org']],
  ['pnas', ['pnas.org']],
  ['cell', ['cell.com']],
  ['lancet', ['thelancet.com']],
  ['nejm', ['nejm.org']],
  ['taylor-francis', ['tandfonline.com']],
  ['sage', ['sagepub.com']],
  ['biorxiv', ['biorxiv.org']],
  ['medrxiv', ['medrxiv.org']],
  ['ssrn', ['ssrn.com']],
  ['acl', ['aclanthology.org']],
  ['openreview', ['openreview.net']],
  ['semantic-scholar', ['semanticscholar.org']],
  ['aps', ['aps.org']],
  ['iop', ['iop.org', 'iopscience.iop.org']],
  ['royal-society', ['royalsocietypublishing.org']],
  ['pubmed', ['ncbi.nlm.nih.gov']],
  ['plos', ['plos.org']],
  ['mdpi', ['mdpi.com']],
  ['frontiers', ['frontiersin.org']],
]

/** True when `host` equals `label` or is a subdomain of it (whole-label suffix). */
function hostMatches(host: string, label: string): boolean {
  return host === label || host.endsWith(`.${label}`)
}

/**
 * Classify a URL by its host. Case-insensitive host; path/query never affect
 * the match. Unparsable URLs are `'other'` with no publisher tag.
 */
export function classifyLink(url: string): ArchivedLink {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return { url, kind: 'other' }
  }
  for (const [publisher, hosts] of PUBLISHERS) {
    if (hosts.some((h) => hostMatches(host, h))) {
      return { url, kind: 'scholarly', publisher }
    }
  }
  return { url, kind: 'other' }
}

interface UrlEntity {
  readonly url?: unknown
  readonly expanded_url?: unknown
}

/**
 * Read X's `entities.urls[]`, preferring `expanded_url` over the `t.co` short
 * url, skipping entries with neither. Dedupes by the chosen URL (first wins).
 * Tolerates any malformed shape (⇒ `[]`).
 */
export function extractLinks(entities: unknown): ArchivedLink[] {
  if (typeof entities !== 'object' || entities === null) return []
  const urls = (entities as { urls?: unknown }).urls
  if (!Array.isArray(urls)) return []
  const out: ArchivedLink[] = []
  const seen = new Set<string>()
  for (const raw of urls) {
    if (typeof raw !== 'object' || raw === null) continue
    const e = raw as UrlEntity
    const chosen =
      typeof e.expanded_url === 'string' && e.expanded_url !== ''
        ? e.expanded_url
        : typeof e.url === 'string' && e.url !== ''
          ? e.url
          : null
    if (chosen === null || seen.has(chosen)) continue
    seen.add(chosen)
    out.push(classifyLink(chosen))
  }
  return out
}

/** Filter classified links by archive link mode. */
export function filterLinks(links: ReadonlyArray<ArchivedLink>, mode: LinkMode): ArchivedLink[] {
  if (mode === 'none') return []
  if (mode === 'all') return [...links]
  return links.filter((l) => l.kind === 'scholarly')
}
