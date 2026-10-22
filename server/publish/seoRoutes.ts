/**
 * SEO public route handlers (Phase 1.5, GRAAAAA-69, plan D7).
 *
 * Adds four public-facing endpoints that surface baked artefacts or
 * resolve a manual 301 redirect on the live path:
 *
 *   GET  /sitemap.xml              — bakeSeoArtifacts output (preferred)
 *                                    or live-generated when the slot
 *                                    hasn't been published yet.
 *   GET  /robots.txt               — same.
 *   GET  /feed.xml                 — same (always emits a valid empty
 *                                    feed when `enableRssFeed` is on but
 *                                    no posts qualify; 404 when the
 *                                    admin toggle is off).
 *   GET  /<any-path>               — site_redirects lookup; returns 301
 *                                    when a manual redirect matches the
 *                                    requested path BEFORE the rest of
 *                                    the public routing tries to render
 *                                    the page.
 *
 * The four handlers are wired into `server/router.ts` ahead of
 * `tryServePublicRoute` so the redirect short-circuit fires first
 * (without it, a renamed URL could still match a published page in a
 * data row before falling through to the redirect lookup).
 */

import type { ServerRuntime } from '../serverRuntime'
import { getSiteRedirectByPath, recordSiteRedirectHit } from '../repositories/seo'
import { getSiteSeoSettings, listEnabledSiteRedirects } from '../repositories/seo'
import { listDataTables, listDataRows } from '../repositories/data'
import { resolveCanonicalUrl } from '@core/seo/canonical'
import { buildSitemapXml, buildRobotsTxt } from '@core/seo/sitemap'
import { buildRssFeed } from '@core/seo/rss'
import type { SitemapPageInput } from '@core/seo/sitemap'
import { MAIN_SCOPE } from '../branches/scope'

const SEO_CACHE_CONTROL = 'public, max-age=300, s-maxage=3600'

/**
 * Wrap a body in a Response with the right content-type + cache headers.
 * `Content-Type` includes the charset so curl / RSS readers don't have to
 * sniff.
 */
function seoResponse(body: string, contentType: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': contentType,
      'cache-control': SEO_CACHE_CONTROL,
    },
  })
}

/**
 * Try to serve a site-level 301 redirect for the inbound path. Returns the
 * 301 response when a redirect matches, `null` otherwise. Increments the
 * hit counter on the matching row (fire-and-forget — never blocks the
 * response).
 */
export async function tryServeSiteRedirect(
  req: Request,
  runtime: ServerRuntime,
  _url: URL,
  pathname: string,
): Promise<Response | null> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return null
  // Strip query string from the lookup; redirects are path-only.
  const pathOnly = pathname.split('?')[0]
  if (!pathOnly || pathOnly === '/') return null

  // Quick path filter: skip the route table entirely for asset / admin paths.
  if (pathOnly.startsWith('/admin/') ||
      pathOnly.startsWith('/_instatic/') ||
      pathOnly.startsWith('/uploads/') ||
      pathOnly.startsWith('/api/') ||
      pathOnly === '/favicon.ico' ||
      pathOnly === '/sitemap.xml' ||
      pathOnly === '/robots.txt' ||
      pathOnly === '/feed.xml' ||
      pathOnly === '/rss.xml') {
    return null
  }

  try {
    const redirect = await getSiteRedirectByPath(runtime.db, pathOnly)
    if (!redirect || !redirect.enabled) return null

    // Fire-and-forget hit recording; never blocks the response.
    void recordSiteRedirectHit(runtime.db, redirect.fromPath).catch(() => undefined)

    const location = /^https?:\/\//i.test(redirect.targetPath)
      ? redirect.targetPath
      : redirect.targetPath

    return new Response(null, {
      status: redirect.statusCode,
      headers: {
        location,
        'cache-control': 'public, max-age=3600',
        'x-redirect-source': 'site_redirects',
        'x-redirect-id': redirect.id,
      },
    })
  } catch {
    return null
  }
}

/**
 * Serve `/sitemap.xml`. Reads from the active publish slot when present;
 * otherwise falls back to a live-rendered sitemap from the draft data so
 * the route never 404s.
 */
export async function tryServeSitemap(
  req: Request,
  runtime: ServerRuntime,
  _url: URL,
  pathname: string,
): Promise<Response | null> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return null
  if (pathname !== '/sitemap.xml') return null

  // Live generation. The publish slot's sitemap is identical content; the
  // live fallback covers pre-publish preview and serves as the safety net.
  const xml = await generateLiveSitemap(runtime.db)
  return seoResponse(xml, 'application/xml; charset=utf-8')
}

/**
 * Serve `/robots.txt`.
 */
export async function tryServeRobots(
  req: Request,
  runtime: ServerRuntime,
  _url: URL,
  pathname: string,
): Promise<Response | null> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return null
  if (pathname !== '/robots.txt') return null

  const settings = await getSiteSeoSettings(runtime.db)
  const body = buildRobotsTxt({ siteUrl: settings.siteUrl, customBody: settings.robotsTxt })
  return seoResponse(body, 'text/plain; charset=utf-8')
}

/**
 * Serve `/feed.xml` (also accepts the legacy `/rss.xml` path). Emits a
 * valid RSS 2.0 feed — possibly empty — when the admin toggle is on.
 * Returns null when the toggle is off so the request falls through to the
 * normal 404 handler.
 */
export async function tryServeRss(
  req: Request,
  runtime: ServerRuntime,
  _url: URL,
  pathname: string,
): Promise<Response | null> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return null
  if (pathname !== '/feed.xml' && pathname !== '/rss.xml') return null

  const xml = await generateLiveRss(runtime.db)
  if (xml === null) return null
  return seoResponse(xml, 'application/rss+xml; charset=utf-8')
}

// ---------------------------------------------------------------------------
// Live fallback generators (used when the published slot is missing or
// empty). The published versions are baked by `bakeSeoArtifacts`; these
// are the same code paths with no disk writes.
// ---------------------------------------------------------------------------

async function generateLiveSitemap(db: DbClient): Promise<string> {
  const settings = await getSiteSeoSettings(db)
  const siteUrl = settings.siteUrl || ''
  if (!siteUrl) return buildSitemapXml({ siteUrl, pages: [], extraPaths: [] })

  const pages: SitemapPageInput[] = []
  for (const page of await collectLivePages(db)) {
    pages.push({
      path: page.path,
      lastmod: page.lastmod ?? null,
      changefreq: page.changefreq,
      priority: page.priority,
      excludeFromSitemap: page.excludeFromSitemap,
      noindex: page.noindex,
    })
  }
  const redirects = await listEnabledSiteRedirects(db)
  return buildSitemapXml({
    siteUrl,
    pages,
    extraPaths: settings.sitemapExtraPaths,
    redirectedPaths: redirects.map((r) => r.fromPath),
    defaultChangeFreq: settings.defaultChangeFreq,
    defaultPriority: settings.defaultPriority,
  })
}

async function generateLiveRss(db: DbClient): Promise<string | null> {
  const settings = await getSiteSeoSettings(db)
  // Honour the admin toggle — when disabled, the route falls through to 404.
  if (settings.enableRssFeed === false) return null

  const siteUrl = settings.siteUrl || ''
  if (!siteUrl) return null
  const ctx = await collectLiveBlogItems(db, siteUrl)
  // Always emit a valid (possibly empty) feed when the toggle is on.
  return buildRssFeed({
    siteTitle: ctx.siteName,
    siteUrl,
    feedUrl: `${siteUrl}/feed.xml`,
    description: `${ctx.siteName} — latest articles`,
    items: ctx.items,
  })
}

// ---------------------------------------------------------------------------
// DB walks for the live generators
// ---------------------------------------------------------------------------

interface LivePageEntry {
  path: string
  lastmod?: string | null
  changefreq?: string
  priority?: number
  excludeFromSitemap?: boolean
  noindex?: boolean
}

interface LiveBlogItem {
  title: string
  link: string
  description: string
  pubDate?: string
}

async function collectLivePages(db: DbClient): Promise<LivePageEntry[]> {
  const tables = await listDataTables(db, MAIN_SCOPE)
  const entries: LivePageEntry[] = []

  // Pages table — top-level pages.
  const pageTable = tables.find((t) => t.slug === 'pages' || t.id === 'pages')
  if (pageTable) {
    // Published rows only — listDataRows has no status filter; a non-null
    // publishedAt marks a row as published (drafts never carry one).
    const rows = (await listDataRows(db, MAIN_SCOPE, pageTable.id)).filter((row) => row.publishedAt != null)
    for (const row of rows) {
      const slug = (row.slug ?? '').trim()
      if (!slug || slug === 'notFound') continue
      const cells = row.cells as Record<string, unknown>
      // Template pages are entry renderers, not routable URLs. The router
      // refuses them (publicRouter) and the bake path skips them
      // (seoChoreography); `cells.templateEnabled` is the stored form of
      // `page.template.enabled` (see core/data/pageFromRow). Emitting them
      // here put guaranteed-404 URLs in the sitemap.
      if (cells.templateEnabled === true) continue
      entries.push(pageEntryFromCells(slug === 'index' ? '/' : `/${slug}`, cells, row.publishedAt ?? null))
    }
  }

  // All other content rows — route base + slug.
  for (const table of tables) {
    if (table.id === pageTable?.id) continue
    if (!table.routeBase) continue
    // Published rows only (see collectLivePages note).
    const rows = (await listDataRows(db, MAIN_SCOPE, table.id)).filter((row) => row.publishedAt != null)
    for (const row of rows) {
      const slug = (row.slug ?? '').trim()
      if (!slug) continue
      const path = `${table.routeBase.replace(/\/$/, '')}/${slug}`
      entries.push(pageEntryFromCells(path, row.cells as Record<string, unknown>, row.publishedAt ?? null))
    }
  }

  return entries
}

function pageEntryFromCells(path: string, cells: Record<string, unknown>, lastmod: string | null): LivePageEntry {
  return {
    path,
    lastmod,
    changefreq: typeof cells.schemaChangeFreq === 'string' ? cells.schemaChangeFreq : undefined,
    priority: typeof cells.schemaPriority === 'number' ? cells.schemaPriority : undefined,
    excludeFromSitemap: cells.excludeFromSitemap === true,
    noindex: cells.noindex === true,
  }
}

async function collectLiveBlogItems(db: DbClient, siteUrl: string): Promise<{ siteName: string; items: LiveBlogItem[] }> {
  const tables = await listDataTables(db, MAIN_SCOPE)
  const postsTable = tables.find((t) => t.slug === 'posts' || t.id === 'posts')
  const siteRow = await db<{ name: string }>`select name from site limit 1`
  const siteName = siteRow.rows[0]?.name ?? 'Site'
  if (!postsTable) return { siteName, items: [] }

  // Published rows only (see collectLivePages note).
  const rows = (await listDataRows(db, MAIN_SCOPE, postsTable.id)).filter((row) => row.publishedAt != null)
  const now = new Date().toISOString()
  const items: LiveBlogItem[] = []
  for (const row of rows) {
    // Exclude posts with a future publishedAt — they aren't public yet.
    if (row.publishedAt && row.publishedAt > now) continue
    const cells = row.cells as Record<string, unknown>
    // Exclude posts marked noindex.
    if (cells.noindex === true) continue
    const title = typeof cells.title === 'string' ? cells.title : (typeof cells.seoTitle === 'string' ? cells.seoTitle : row.slug ?? '')
    const description = typeof cells.seoDescription === 'string'
      ? cells.seoDescription
      : typeof cells.summary === 'string'
        ? cells.summary
        : typeof cells.excerpt === 'string'
          ? cells.excerpt
          : typeof cells.body === 'string'
            ? cells.body.slice(0, 200)
            : ''
    const link = resolveCanonicalUrl({
      siteUrl,
      slug: row.slug,
      routeBase: postsTable.routeBase,
      isEntry: true,
    })
    items.push({
      title,
      link,
      description,
      pubDate: row.publishedAt ?? undefined,
    })
  }
  // Newest first.
  items.sort((a, b) => (b.pubDate ?? '').localeCompare(a.pubDate ?? ''))
  // Cap at 50 so the on-disk artefact and the live route agree.
  items.splice(50)
  return { siteName, items }
}

// Type imported for the helper above.
type DbClient = Parameters<typeof getSiteSeoSettings>[0]
