/**
 * SEO artefact baking (Phase 1.5, GRAAAAA-69, plan D7).
 *
 * Writes the SEO static artefacts to the inactive publish slot:
 *
 *   <slot>/sitemap.xml          — last published URL inventory
 *   <slot>/robots.txt           — site robots policy
 *   <slot>/feed.xml             — blog post feed (always emitted as a
 *                                  valid RSS 2.0 document when
 *                                  `enableRssFeed` is on; empty feed
 *                                  when no posts qualify)
 *   <slot>/rss.xml              — legacy alias of /feed.xml kept for
 *                                  existing RSS reader subscriptions
 *   <slot>/.well-known/redirects.json — bulk 301 manifest, for CDN
 *                                        edge deployment (Cloudflare
 *                                        Bulk Redirects import format).
 *
 * All four are idempotent and re-run on every publish so they reflect
 * the page set exactly at bake time. The choreography hook fires after
 * the slot is swapped so the CF zone purge includes these paths
 * automatically.
 *
 * The redirect manifest is intentionally written even though the
 * publisher also serves 301s at request time. Edge-deployed redirects
 * shave a round-trip and ensure redirects work even when the origin is
 * unreachable (origin-down 301s still serve from edge).
 */

import { writeStaticAsset } from './staticArtefact'
import type { SitemapPageInput } from '@core/seo/sitemap'
import { buildSitemapXml, buildRobotsTxt } from '@core/seo/sitemap'
import { buildRssFeed } from '@core/seo/rss'
import type { SiteSeoContext } from '@core/seo/seoSettings'
import { listEnabledSiteRedirects } from '../repositories/seo'
import type { SiteRedirectRow } from '@core/seo/types'
import type { DbClient } from '../db/client'

const textEncoder = new TextEncoder()

/** Encode + write a UTF-8 text artefact (sitemap, robots, feeds, manifest). */
async function writeTextAsset(slotDir: string, publicPath: string, text: string): Promise<void> {
  await writeStaticAsset(slotDir, publicPath, textEncoder.encode(text))
}

export interface SeoBakePage {
  /** Path under the site root (`/about`, `/services/kitchen`). */
  path: string
  /** ISO 8601 publish / last-modified timestamp. */
  lastmod?: string | null
  schemaPriority?: number
  schemaChangeFreq?: string
  excludeFromSitemap?: boolean
  noindex?: boolean
  /** true for content rows; false for top-level pages. */
  isEntry?: boolean
  /**
   * Used for blog feed entries only — title + description + pubDate.
   * Other page kinds leave this empty.
   */
  rssItem?: { title: string; description: string; pubDate?: string }
}

export interface SeoBakeInput {
  db: DbClient
  slotDir: string
  site: { id: string; name: string }
  pages: SeoBakePage[]
  siteSeoContext: SiteSeoContext
  blogFeed?: {
    enabled: boolean
    siteUrl: string
    feedUrl: string
    description: string
    language?: string
    author?: string
    items: Array<{ title: string; link: string; description: string; pubDate?: string; categories?: string[] }>
  }
  /** Publish timestamp used as fallback `lastmod`. */
  publishedAt?: string
}

export async function bakeSeoArtifacts(input: SeoBakeInput): Promise<{
  sitemapPath: string
  robotsPath: string
  rssPath: string | null
  redirectsPath: string | null
  redirectCount: number
}> {
  const { site, siteSeoContext } = input
  const settings = siteSeoContext.settings
  const siteUrl = settings.siteUrl || ''

  // ----- sitemap.xml ---------------------------------------------------

  const sitemapPages: SitemapPageInput[] = input.pages.map((page) => ({
    path: page.path,
    lastmod: page.lastmod ?? input.publishedAt ?? null,
    changefreq: page.schemaChangeFreq ?? settings.defaultChangeFreq,
    priority: page.schemaPriority ?? settings.defaultPriority,
    excludeFromSitemap: page.excludeFromSitemap ?? false,
    noindex: page.noindex ?? false,
  }))

  // Cross-reference enabled redirects so the sitemap doesn't list paths
  // that 301 elsewhere. Sourced from the same db, the same as
  // publicRouter's lookup path, so the two views never diverge.
  const redirects = await listEnabledSiteRedirects(input.db)
  const redirectedPaths = redirects.map((r) => r.fromPath)

  const sitemapXml = buildSitemapXml({
    siteUrl,
    pages: sitemapPages,
    extraPaths: settings.sitemapExtraPaths,
    redirectedPaths,
    publishedAt: input.publishedAt,
    defaultChangeFreq: settings.defaultChangeFreq,
    defaultPriority: settings.defaultPriority,
  })
  await writeTextAsset(input.slotDir, '/sitemap.xml', sitemapXml)

  // ----- robots.txt ----------------------------------------------------

  const robotsTxt = buildRobotsTxt({ siteUrl, customBody: settings.robotsTxt })
  await writeTextAsset(input.slotDir, '/robots.txt', robotsTxt)

  // ----- feed.xml (blog feed) ------------------------------------------

  let rssPath: string | null = null
  // Emit a valid (possibly empty) feed whenever the admin toggle is on.
  // Empty feeds are valid RSS 2.0 and let readers poll for new content
  // without ever seeing a 404.
  if (input.blogFeed?.enabled && siteUrl && settings.enableRssFeed !== false) {
    const xml = buildRssFeed({
      siteTitle: site.name,
      siteUrl,
      feedUrl: input.blogFeed.feedUrl || `${siteUrl}/feed.xml`,
      description: input.blogFeed.description || `${site.name} — latest articles`,
      ...(input.blogFeed.language ? { language: input.blogFeed.language } : {}),
      ...(input.blogFeed.author ? { author: input.blogFeed.author } : {}),
      items: input.blogFeed.items ?? [],
    })
    // Canonical path.
    await writeTextAsset(input.slotDir, '/feed.xml', xml)
    // Legacy alias — same bytes so existing reader subscriptions survive
    // the rename. (Separate file so the response Cache-Control can vary if
    // we ever need to deprecate it.)
    await writeTextAsset(input.slotDir, '/rss.xml', xml)
    rssPath = '/feed.xml'
  }

  // ----- .well-known/redirects.json -----------------------------------

  const redirectsPath = '/.well-known/redirects.json'
  const redirectManifest = buildRedirectManifest(siteUrl, redirects)
  await writeTextAsset(input.slotDir, redirectsPath, JSON.stringify(redirectManifest, null, 2))

  return {
    sitemapPath: '/sitemap.xml',
    robotsPath: '/robots.txt',
    rssPath,
    redirectsPath,
    redirectCount: redirects.length,
  }
}

/**
 * Build a Cloudflare Bulk Redirects-compatible JSON manifest. Operators
 * can copy this file's content into a Cloudflare Bulk Redirects list
 * import to push all site_redirects rows to edge nodes without writing
 * per-row API calls.
 *
 * Format reference: https://developers.cloudflare.com/rules/url-forwarding/bulk-redirects/create-dashboard/#bulk-redirects-list
 *
 *   {
 *     "description": "site_redirects table — last published at <iso>",
 *     "redirects": [
 *       { "source_url": "/old-page", "target_url": "/new-page", "status_code": 301 }
 *     ]
 *   }
 */
export function buildRedirectManifest(siteUrl: string, redirects: SiteRedirectRow[]) {
  return {
    description: `site_redirects table — last published at ${new Date().toISOString()}`,
    source: siteUrl || undefined,
    redirects: redirects.map((r) => {
      const source = absoluteOrRelative(r.fromPath, siteUrl)
      const target = /^https?:\/\//i.test(r.targetPath)
        ? r.targetPath
        : absoluteOrRelative(r.targetPath, siteUrl)
      return {
        source_url: source,
        target_url: target,
        status_code: r.statusCode,
      }
    }),
  }
}

function absoluteOrRelative(path: string, siteUrl: string): string {
  if (!siteUrl) return path
  if (/^https?:\/\//i.test(path)) return path
  return `${siteUrl.replace(/\/+$/, '')}${path.startsWith('/') ? '' : '/'}${path}`
}
