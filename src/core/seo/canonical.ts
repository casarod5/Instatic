/**
 * Canonical URL resolution (Phase 1.5, GRAAAAA-69, plan D7).
 *
 * Builds an absolute URL for `<link rel="canonical">` and `og:url`. The
 * site URL is configurable per site; an empty `siteUrl` disables absolute
 * URL synthesis so a draft site never advertises `null/...` to crawlers.
 *
 *   resolveCanonicalUrl({ siteUrl: 'https://granitecrm.com', slug: 'about', routeBase: '/services' })
 *     → 'https://granitecrm.com/services/about'
 *
 *   resolveCanonicalUrl({ siteUrl: '', slug: 'about' })
 *     → ''  (empty — caller decides what to do)
 *
 *   resolveCanonicalUrl({ siteUrl: 'http://localhost:3000/', slug: 'index' })
 *     → 'http://localhost:3000/'  (root collapses `index`)
 */

export interface CanonicalInput {
  siteUrl: string
  slug: string
  routeBase?: string
  /**
   * Whether this is a content row (uses `routeBase + slug`) or a top-level
   * page (uses `slug` only). Default `false` (top-level page).
   */
  isEntry?: boolean
}

export function resolveCanonicalUrl(input: CanonicalInput): string {
  const siteUrl = (input.siteUrl ?? '').trim().replace(/\/+$/, '')
  if (!siteUrl) return ''

  const slug = (input.slug ?? '').trim()
  if (!slug) return `${siteUrl}/`

  // Top-level pages: the slug is the path. Empty slug (root) → '/'.
  if (!input.isEntry) {
    if (slug === 'index' || slug === '/') return `${siteUrl}/`
    return `${siteUrl}/${slug.replace(/^\/+/, '')}`
  }

  // Entries: routeBase + slug.
  const base = (input.routeBase ?? '').trim().replace(/\/+$/, '')
  if (base) {
    return `${siteUrl}${base}/${slug.replace(/^\/+/, '')}`
  }
  return `${siteUrl}/${slug.replace(/^\/+/, '')}`
}
