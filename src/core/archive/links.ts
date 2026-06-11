import type { ArchiveLinkScope } from '../schema'

/** One external link kept in a tweet's history record. */
export interface ArchiveLink {
  readonly url: string
  readonly scholarly: boolean
}

/**
 * Hosts of scholarly publishers and preprint servers. A link counts as
 * scholarly when its hostname IS one of these or is a subdomain of one
 * (`link.springer.com` matches `springer.com`). Exact-suffix matching with a
 * dot boundary — `notarxiv.org` does not match `arxiv.org`.
 */
export const SCHOLARLY_HOSTS: ReadonlyArray<string> = [
  // Preprints & identifiers
  'arxiv.org',
  'biorxiv.org',
  'medrxiv.org',
  'ssrn.com',
  'doi.org',
  'osf.io',
  'zenodo.org',
  'hal.science',
  // Major publishers
  'springer.com',
  'springernature.com',
  'biomedcentral.com',
  'nature.com',
  'cambridge.org',
  'oup.com',
  'oxfordjournals.org',
  'sciencedirect.com',
  'elsevier.com',
  'cell.com',
  'thelancet.com',
  'wiley.com',
  'tandfonline.com',
  'sagepub.com',
  'degruyter.com',
  'brill.com',
  'worldscientific.com',
  // Societies & journals
  'ieee.org',
  'acm.org',
  'acs.org',
  'aps.org',
  'iop.org',
  'siam.org',
  'ams.org',
  'science.org',
  'pnas.org',
  'plos.org',
  'frontiersin.org',
  'mdpi.com',
  'royalsocietypublishing.org',
  'projecteuclid.org',
  'jstor.org',
  'ncbi.nlm.nih.gov',
  // University presses & ML venues
  'mitpress.mit.edu',
  'press.princeton.edu',
  'hup.harvard.edu',
  'openreview.net',
  'aclanthology.org',
  'mlr.press',
  'neurips.cc',
  'semanticscholar.org',
] as const

const hostMatches = (hostname: string, host: string): boolean =>
  hostname === host || hostname.endsWith(`.${host}`)

/** True when the URL points at a scholarly publisher / preprint host. */
export function isScholarlyUrl(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  const hostname = u.hostname.toLowerCase()
  return SCHOLARLY_HOSTS.some((host) => hostMatches(hostname, host))
}

/**
 * Classify and filter a tweet's expanded URLs for its history record:
 * de-duplicated, each tagged `scholarly`, narrowed by the configured scope.
 */
export function selectLinks(
  urls: ReadonlyArray<string>,
  scope: ArchiveLinkScope,
): ReadonlyArray<ArchiveLink> {
  if (scope === 'none') return []
  const out: ArchiveLink[] = []
  const seen = new Set<string>()
  for (const url of urls) {
    if (url === '' || seen.has(url)) continue
    seen.add(url)
    const scholarly = isScholarlyUrl(url)
    if (scope === 'scholarly' && !scholarly) continue
    out.push({ url, scholarly })
  }
  return out
}
