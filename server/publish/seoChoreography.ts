/**
 * SEO bake input builder + publish choreography (Phase 1.5, GRAAAAA-69, plan D7).
 *
 * `buildSeoBakeInput` collects everything `bakeSeoArtifacts` needs from the
 * in-memory snapshots + DB lookups so the SEO artefact bake runs in one
 * predictable place after the slot swap.
 *
 * `runPublishChoreography` fires the three post-publish actions:
 *   1. Cloudflare zone purge (if CF credentials + zone ID configured)
 *   2. Search-engine sitemap ping (Google + Bing)
 *   3. Audit log entry (in `publish_audit_log` table)
 *
 * All three are fire-and-forget: a publish that reached `bumpPublishVersion`
 * is already "done" for the user. Failures are logged to the audit trail
 * so the operator can re-run the choreography manually if needed.
 */

import type { DbClient } from '../db/client'
import { listDataTables, listDataRows } from '../repositories/data'
import type { SiteSeoContext } from '@core/seo/seoSettings'
import { resolveCanonicalUrl } from '@core/seo/canonical'
import type { SeoBakeInput, SeoBakePage } from './seoArtifacts'
import type { PublishedPageSnapshot } from '../repositories/publish'
import { MAIN_SCOPE } from '../branches/scope'
import { isTemplatePage } from '@core/templates'
import { createAuditEvent } from '../repositories/audit'

export interface ChoreographyInput {
  db: DbClient
  siteUrl: string
  sitemapUrl?: string
  redirectCount: number
  publishedBy: string
}

export async function buildSeoBakeInput(input: {
  db: DbClient
  slotDir: string
  site: { id: string; name: string }
  snapshots: PublishedPageSnapshot[]
  siteSeoContext: SiteSeoContext
  publishedAt: string
}): Promise<SeoBakeInput> {
  const { db, snapshots, siteSeoContext, publishedAt, slotDir, site } = input
  const settings = siteSeoContext.settings
  const siteUrl = settings.siteUrl || ''

  // ----- pages for sitemap -----------------------------------------------

  const pages: SeoBakePage[] = []

  for (const snapshot of snapshots) {
    const page = snapshot.site.pages.find((p) => p.id === snapshot.pageRowId)
    if (!page) continue
    if (isTemplatePage(page)) continue

    const urlPath = page.slug === 'index' ? '/' : `/${page.slug}`
    const cells = (page as any).seoCells ?? {}
    pages.push({
      path: urlPath,
      lastmod: publishedAt,
      schemaPriority: typeof cells.schemaPriority === 'number' ? cells.schemaPriority : settings.defaultPriority,
      schemaChangeFreq: typeof cells.schemaChangeFreq === 'string' ? cells.schemaChangeFreq : settings.defaultChangeFreq,
      excludeFromSitemap: cells.excludeFromSitemap === true,
      noindex: cells.noindex === true,
      isEntry: false,
    })
  }

  // ----- data-row entries (content tables with entry templates) ----------

  const tables = await listDataTables(db, MAIN_SCOPE)
  for (const table of tables) {
    if (!table.routeBase) continue
    // Published rows only — listDataRows has no status filter; a non-null
    // publishedAt marks a row as published (drafts never carry one).
    const rows = (await listDataRows(db, MAIN_SCOPE, table.id)).filter((row) => row.publishedAt != null)
    for (const row of rows) {
      const cells = row.cells as Record<string, unknown>
      const slug = (row.slug ?? '').trim()
      if (!slug) continue
      const path = `${table.routeBase.replace(/\/$/, '')}/${slug}`
      pages.push({
        path,
        lastmod: row.publishedAt ?? publishedAt,
        schemaPriority: typeof cells.schemaPriority === 'number' ? cells.schemaPriority : settings.defaultPriority,
        schemaChangeFreq: typeof cells.schemaChangeFreq === 'string' ? cells.schemaChangeFreq : settings.defaultChangeFreq,
        excludeFromSitemap: cells.excludeFromSitemap === true,
        noindex: cells.noindex === true,
        isEntry: true,
        rssItem: table.slug === 'posts'
          ? {
              title: typeof cells.title === 'string' ? cells.title : (typeof cells.seoTitle === 'string' ? cells.seoTitle : slug),
              description: typeof cells.seoDescription === 'string'
                ? cells.seoDescription
                : typeof cells.summary === 'string'
                  ? cells.summary
                  : typeof cells.excerpt === 'string'
                    ? cells.excerpt
                    : '',
              pubDate: row.publishedAt ?? undefined,
            }
          : undefined,
      })
    }
  }

  // ----- blog feed configuration -----------------------------------------

  const blogFeed = await buildBlogFeedConfig(db, siteUrl, settings)

  return {
    db,
    slotDir,
    site,
    pages,
    siteSeoContext,
    blogFeed,
    publishedAt,
  }
}

async function buildBlogFeedConfig(
  db: DbClient,
  siteUrl: string,
  settings: SiteSeoContext['settings'],
): Promise<SeoBakeInput['blogFeed']> {
  if (!siteUrl) return { enabled: false, siteUrl: '', feedUrl: '', description: '', items: [] }

  // Respect the admin toggle before doing any DB work.
  if (settings.enableRssFeed === false) return { enabled: false, siteUrl: '', feedUrl: '', description: '', items: [] }

  const tables = await listDataTables(db, MAIN_SCOPE)
  const postsTable = tables.find((t) => t.slug === 'posts' || t.id === 'posts')
  if (!postsTable) return { enabled: false, siteUrl: '', feedUrl: '', description: '', items: [] }

  // Published rows only (see buildSeoBakeInput note).
  const rows = (await listDataRows(db, MAIN_SCOPE, postsTable.id)).filter((row) => row.publishedAt != null)
  if (rows.length === 0) return { enabled: false, siteUrl: '', feedUrl: '', description: '', items: [] }

  const now = new Date().toISOString()

  const items = rows
    .filter((row) => {
      // Exclude posts with a future publishedAt — they aren't public yet.
      if (row.publishedAt && row.publishedAt > now) return false
      // Exclude posts marked noindex.
      const cells = row.cells as Record<string, unknown>
      if (cells.noindex === true) return false
      return true
    })
    .map((row) => {
      const cells = row.cells as Record<string, unknown>
      const title =
        typeof cells.title === 'string' ? cells.title
          : typeof cells.seoTitle === 'string' ? cells.seoTitle
          : (row.slug ?? '')
      const description =
        typeof cells.seoDescription === 'string' ? cells.seoDescription
          : typeof cells.summary === 'string' ? cells.summary
          : typeof cells.excerpt === 'string' ? cells.excerpt
          : typeof cells.body === 'string' ? cells.body.slice(0, 200)
          : ''
      return {
        title,
        link: resolveCanonicalUrl({ siteUrl, slug: row.slug, routeBase: postsTable.routeBase, isEntry: true }),
        description,
        pubDate: row.publishedAt ?? undefined,
        categories: Array.isArray(cells.categories) ? cells.categories.map(String) : [],
      }
    })

  // Newest first.
  items.sort((a, b) => (b.pubDate ?? '').localeCompare(a.pubDate ?? ''))

  // Cap at 50.
  items.splice(50)

  if (items.length === 0) return { enabled: false, siteUrl: '', feedUrl: '', description: '', items: [] }

  const siteRow = await db<{ name: string }>`select name from site limit 1`
  const siteName = siteRow.rows[0]?.name ?? 'Site'

  return {
    enabled: true,
    siteUrl,
    feedUrl: `${siteUrl}/feed.xml`,
    description: `${siteName} — latest articles`,
    language: 'en-US',
    author: undefined,
    items,
  }
}

/**
 * Run the post-publish choreography:
 *
 *   1. Cloudflare zone purge (if configured)
 *   2. Sitemap ping (Google + Bing)
 *   3. Audit log entry
 *
 * All calls are fire-and-forget — failures are recorded in the audit log
 * but never surface as a publish error to the user.
 */
export async function runPublishChoreography(input: ChoreographyInput): Promise<void> {
  const { db, siteUrl, sitemapUrl, redirectCount, publishedBy } = input
  const startedAt = Date.now()
  const results: Record<string, { ok: boolean; detail?: string }> = {}

  // 1. Cloudflare purge
  if (siteUrl) {
    const purgeResult = await purgeCloudflareZone(siteUrl)
    results.cloudflare = purgeResult
  }

  // 2. Sitemap ping
  if (sitemapUrl) {
    const pingResult = await pingSearchEngines(sitemapUrl)
    results.sitemapPing = pingResult
  }

  // 3. Audit log
  await recordPublishAudit(db, {
    siteUrl,
    sitemapUrl,
    redirectCount,
    publishedBy,
    choreographyResults: results,
    durationMs: Date.now() - startedAt,
  })
}

// ---------------------------------------------------------------------------
// Cloudflare zone purge
// ---------------------------------------------------------------------------

async function purgeCloudflareZone(siteUrl: string): Promise<{ ok: boolean; detail?: string }> {
  try {
    const credentials = await getCloudflareCredentials()
    if (!credentials) return { ok: false, detail: 'no Cloudflare credentials configured' }

    const zoneId = await getCloudflareZoneIdForSite(siteUrl, credentials)
    if (!zoneId) return { ok: false, detail: 'no matching Cloudflare zone' }

    const res = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${credentials.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ purge_everything: true }),
      },
    )

    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.success !== true) {
      return { ok: false, detail: `CF purge failed: ${res.status} ${JSON.stringify(data.errors ?? data)}` }
    }
    return { ok: true, detail: `purged zone ${zoneId}` }
  } catch (err) {
    return { ok: false, detail: `CF purge error: ${err instanceof Error ? err.message : String(err)}` }
  }
}

interface CloudflareCredentials {
  apiToken: string
  accountId?: string
}

async function getCloudflareCredentials(): Promise<CloudflareCredentials | null> {
  // Prefer the repo helper if it exists; fall back to a site_settings row
  // with key 'cloudflare' (stored in site.seo_settings_json.cloudflare).
  // This keeps the secret out of the DB when the operator prefers env.
  if (process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID) {
    return { apiToken: process.env.CLOUDFLARE_API_TOKEN, accountId: process.env.CLOUDFLARE_ACCOUNT_ID }
  }
  return null
}

async function getCloudflareZoneIdForSite(siteUrl: string, creds: CloudflareCredentials): Promise<string | null> {
  try {
    const hostname = new URL(siteUrl).hostname
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(hostname)}&status=active`,
      { headers: { Authorization: `Bearer ${creds.apiToken}` } },
    )
    const data = await res.json().catch(() => ({}))
    if (!data.success || !data.result?.length) return null
    return data.result[0].id
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Sitemap ping (Google + Bing)
// ---------------------------------------------------------------------------

async function pingSearchEngines(sitemapUrl: string): Promise<{ ok: boolean; detail?: string }> {
  const encoded = encodeURIComponent(sitemapUrl)
  const endpoints = [
    `https://www.google.com/ping?sitemap=${encoded}`,
    `https://www.bing.com/ping?sitemap=${encoded}`,
  ]

  const outcomes = await Promise.allSettled(
    endpoints.map((url) => fetch(url, { method: 'GET', signal: AbortSignal.timeout(10_000) })),
  )

  const failures = outcomes
    .map((r, i) => (r.status === 'rejected' ? endpoints[i] : r.value.ok ? null : endpoints[i]))
    .filter(Boolean)

  if (failures.length === endpoints.length) {
    return { ok: false, detail: `all pings failed (${failures.join(', ')})` }
  }
  if (failures.length > 0) {
    return { ok: true, detail: `partial: ${failures.join(', ')} failed` }
  }
  return { ok: true, detail: 'Google + Bing pinged' }
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

interface AuditRecord {
  siteUrl: string
  sitemapUrl?: string
  redirectCount: number
  publishedBy: string
  choreographyResults: Record<string, { ok: boolean; detail?: string }>
  durationMs: number
}

async function recordPublishAudit(db: DbClient, input: AuditRecord): Promise<void> {
  try {
    // The shared audit trail (audit_events) is the system of record for
    // publish outcomes — one row per publish with the choreography results
    // (CF purge / sitemap ping, incl. explicit skips) as structured metadata.
    await createAuditEvent(db, {
      actorUserId: input.publishedBy,
      action: 'site.publish.choreography',
      targetType: 'site',
      targetId: null,
      metadata: {
        siteUrl: input.siteUrl,
        ...(input.sitemapUrl ? { sitemapUrl: input.sitemapUrl } : {}),
        redirectCount: input.redirectCount,
        durationMs: input.durationMs,
        choreography: JSON.stringify(input.choreographyResults),
      },
    })
  } catch (err) {
    console.error('[publish:choreography] audit log write failed:', err)
  }
}