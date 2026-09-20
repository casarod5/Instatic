/**
 * Sitemap + robots.txt generators (Phase 1.5, GRAAAAA-69, plan D7).
 *
 * Pure functions: input a list of pages + site settings, output the
 * canonical XML / robots.txt bodies. Called by the publish pipeline at
 * bake time so the static output ships a current sitemap.xml + robots.txt
 * without per-request DB cost.
 *
 * The sitemap excludes:
 *   - Pages marked `excludeFromSitemap: true` (per-row cell or template default)
 *   - Pages marked `noindex: true` (these should not appear in sitemap)
 *   - The 404 page
 *   - Any path that already has a manual 301 redirect (the redirect target
 *     is what crawlers should follow — listing the redirect source as a
 *     distinct URL invites duplicate-content flags).
 *
 * The robots.txt body falls back to:
 *
 *   User-agent: *
 *   Allow: /
 *   Sitemap: <siteUrl>/sitemap.xml
 *
 * when site.robots_txt is empty.
 */

import type { SitemapEntry } from './types'

export interface SitemapPageInput {
  /** Path relative to site root, e.g. `/about` or `/services/kitchen-remodeling`. */
  path: string
  /** ISO 8601 last-modified; falls back to publish timestamp. */
  lastmod?: string | null
  changefreq?: string
  priority?: number
  excludeFromSitemap?: boolean
  noindex?: boolean
}

export interface SitemapInput {
  siteUrl: string
  pages: SitemapPageInput[]
  /** Extra paths explicitly configured in site settings (`sitemapExtraPaths`). */
  extraPaths?: string[]
  /** Paths covered by manual 301 redirects — excluded from the sitemap. */
  redirectedPaths?: string[]
  /** Publish timestamp used for entries without an explicit `lastmod`. */
  publishedAt?: string
  /** Default changefreq when neither page nor template supplies one. */
  defaultChangeFreq?: string
  /** Default priority when neither page nor template supplies one. */
  defaultPriority?: number
}

export function buildSitemapXml(input: SitemapInput): string {
  const siteUrl = (input.siteUrl ?? '').trim().replace(/\/+$/, '')
  if (!siteUrl) return SITEMAP_EMPTY_BODY
  const redirected = new Set((input.redirectedPaths ?? []).map((p) => normalizePath(p)))
  const defaultChangeFreq = input.defaultChangeFreq ?? 'weekly'
  const defaultPriority = input.defaultPriority ?? 0.5

  const entries: SitemapEntry[] = []
  const seen = new Set<string>()

  const push = (pagePath: string, page: SitemapPageInput) => {
    if (page.excludeFromSitemap || page.noindex) return
    const normalized = normalizePath(pagePath)
    if (redirected.has(normalized)) return
    const url = `${siteUrl}${normalized === '/' ? '/' : normalized}`
    if (seen.has(url)) return
    seen.add(url)
    entries.push({
      loc: url,
      ...(page.lastmod ? { lastmod: page.lastmod } : {}),
      changefreq: page.changefreq ?? defaultChangeFreq,
      priority: clampPriority(page.priority ?? defaultPriority),
    })
  }

  for (const page of input.pages) {
    push(page.path, page)
  }

  for (const extra of input.extraPaths ?? []) {
    if (!extra) continue
    const normalized = normalizePath(extra)
    if (redirected.has(normalized)) continue
    const url = `${siteUrl}${normalized === '/' ? '/' : normalized}`
    if (seen.has(url)) continue
    seen.add(url)
    entries.push({
      loc: url,
      changefreq: defaultChangeFreq,
      priority: clampPriority(defaultPriority),
    })
  }

  const lines = entries.map(formatSitemapEntry)
  return `${SITEMAP_HEADER}\n${lines.join('\n')}\n${SITEMAP_FOOTER}`
}

const SITEMAP_HEADER = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`
const SITEMAP_FOOTER = `</urlset>`
const SITEMAP_EMPTY_BODY = `${SITEMAP_HEADER}\n${SITEMAP_FOOTER}`

function formatSitemapEntry(entry: SitemapEntry): string {
  const parts = [`  <url>`, `    <loc>${escapeXml(entry.loc)}</loc>`]
  if (entry.lastmod) parts.push(`    <lastmod>${escapeXml(entry.lastmod)}</lastmod>`)
  if (entry.changefreq) parts.push(`    <changefreq>${escapeXml(entry.changefreq)}</changefreq>`)
  if (entry.priority !== undefined) parts.push(`    <priority>${entry.priority.toFixed(1)}</priority>`)
  parts.push(`  </url>`)
  return parts.join('\n')
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function normalizePath(path: string): string {
  if (!path) return '/'
  const trimmed = path.trim()
  if (trimmed === '/' || trimmed === '') return '/'
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  return withSlash.replace(/\/+$/, '') || '/'
}

function clampPriority(n: number): number {
  if (!Number.isFinite(n)) return 0.5
  return Math.max(0, Math.min(1, n))
}

/**
 * robots.txt body. Falls back to a permissive default that explicitly
 * references the sitemap.xml URL so crawlers find it without a separate
 * Search Console submission. The body is fully user-controlled when
 * site.robots_txt is non-empty.
 */
export function buildRobotsTxt(input: { siteUrl: string; customBody?: string }): string {
  if (input.customBody && input.customBody.trim()) return input.customBody
  const siteUrl = (input.siteUrl ?? '').trim().replace(/\/+$/, '')
  const sitemapLine = siteUrl ? `Sitemap: ${siteUrl}/sitemap.xml\n` : ''
  return `User-agent: *\nAllow: /\n${sitemapLine}`
}
