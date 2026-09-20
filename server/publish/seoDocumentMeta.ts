/**
 * Per-page SEO document-meta assembly (Phase 1.5, GRAAAAA-69, plan D7).
 *
 * Bridges the `@core/seo` library into the publisher render paths:
 *
 *   buildDataRowDocumentMeta  — the full per-entry surface for content-row
 *                               pages (the only data-row render path; used
 *                               by BOTH the bake (`bakeDataRows`) and the
 *                               live fallback (`publicRouter`)):
 *                                 (a) title/description/OG/Twitter/canonical
 *                                     via `resolveEntryDocumentMeta`
 *                                     (fallback chain: entry cell →
 *                                     template default → site settings)
 *                                 (b) JSON-LD: site LocalBusiness w/ NAP
 *                                     (per-city override for City Landing
 *                                     rows), Service, FAQ, BreadcrumbList
 *   buildSiteDocumentMeta     — plain page-tree pages: feed discovery +
 *                               site-level LocalBusiness JSON-LD
 *
 * Everything here is additive: with no site settings and no identity
 * configured the returned override is empty and the rendered `<head>`
 * is byte-identical to the pre-Phase-1.5 output.
 */

import type { DbClient } from '../db/client'
import type { DocumentMetaOverride } from '@core/publisher'
import type { PublishedDataRow } from '@core/data/schemas'
import {
  loadSiteSeoContext,
  resolveEntryDocumentMeta,
  buildBreadcrumbStackForPage,
} from '@core/seo/seoSettings'
import {
  buildLocalBusinessJsonLd,
  buildServiceJsonLd,
  buildFaqJsonLd,
  buildBreadcrumbJsonLd,
} from '@core/seo/jsonLd'
import { resolveCanonicalUrl } from '@core/seo/canonical'
import type { FaqItem, PublisherIdentity } from '@core/seo/types'

/** Subset of `RenderPublishedSnapshotContext` the assemblers need. */
export interface SeoRenderContext {
  db: DbClient
  rssFeedUrl?: string
}

/**
 * Table-specific template defaults for the SEO surface. Mirrors the
 * template intent from the Phase 1 contractor-starter seed: blog posts are
 * articles that change weekly; service pages are evergreen (monthly);
 * city landing pages refresh with local content (weekly).
 */
const TABLE_TEMPLATE_DEFAULTS: Record<string, Partial<DocumentMetaOverride>> = {
  posts: { ogType: 'article', schemaChangeFreq: 'weekly' },
  services: { ogType: 'website', schemaChangeFreq: 'monthly' },
  cities: { ogType: 'website', schemaChangeFreq: 'weekly' },
}

export async function buildDataRowDocumentMeta(
  row: PublishedDataRow,
  ctx: SeoRenderContext,
  templateContext: Record<string, unknown> = {},
): Promise<DocumentMetaOverride> {
  const siteSeoContext = await loadSiteSeoContext(ctx.db)
  const identity = siteSeoContext.publisherIdentity
  const siteUrl = siteSeoContext.settings.siteUrl

  const pageTitle =
    typeof row.cells.title === 'string' && row.cells.title.trim()
      ? row.cells.title.trim()
      : row.slug

  const meta = resolveEntryDocumentMeta({
    cells: row.cells,
    page: { title: pageTitle, slug: row.slug, kind: 'entry' },
    tableSlug: row.tableSlug,
    tableRouteBase: row.tableRouteBase,
    templateContext,
    siteSeoContext,
    templateDefaults: TABLE_TEMPLATE_DEFAULTS[row.tableSlug],
  })

  const canonical =
    meta.canonicalUrl ||
    resolveCanonicalUrl({ siteUrl, slug: row.slug, routeBase: row.tableRouteBase, isEntry: true })

  const jsonLd = assembleDataRowJsonLd({ row, pageTitle, canonical, identity, siteUrl })

  return {
    ...meta,
    ...(ctx.rssFeedUrl ? { rssFeedUrl: ctx.rssFeedUrl } : {}),
    ...(jsonLd.length > 0 ? { jsonLd } : {}),
  }
}

/**
 * Pure JSON-LD assembly for one data row — split from the async wrapper so
 * tests can exercise it without a database.
 */
export function assembleDataRowJsonLd(input: {
  row: Pick<PublishedDataRow, 'tableSlug' | 'tableRouteBase' | 'slug' | 'cells'>
  pageTitle: string
  canonical: string
  identity: PublisherIdentity
  siteUrl: string
}): unknown[] {
  const { row, pageTitle, canonical, identity, siteUrl } = input
  const jsonLd: unknown[] = []
  const city = text(row.cells.title)
  const state = text(row.cells.state)

  // ---- LocalBusiness (site default; per-city for City Landing rows) ----
  if (row.tableSlug === 'cities') {
    // City Landing: one LocalBusiness per city, NAP overridden from the
    // entry's typed fields (title/state/phone). Replaces the site-level
    // entity so validators see exactly one LocalBusiness per page.
    if (city || identity.name) {
      const baseAddress = identity.address
      const address =
        baseAddress || city || state
          ? {
              ...(baseAddress ?? {
                '@type': 'PostalAddress',
                streetAddress: '',
                addressLocality: '',
                addressRegion: '',
                postalCode: '',
                addressCountry: 'US',
              }),
              ...(city ? { addressLocality: city } : {}),
              ...(state ? { addressRegion: state } : {}),
            }
          : undefined
      jsonLd.push(
        buildLocalBusinessJsonLd(identity, {
          name:
            identity.name && city
              ? `${identity.name} — ${city}`
              : city || identity.name,
          ...(text(row.cells.phone) ? { telephone: text(row.cells.phone) } : {}),
          ...(address ? { address } : {}),
          ...(city ? { areaServed: state ? `${city}, ${state}` : city } : {}),
          ...(canonical ? { url: canonical } : {}),
        }),
      )
    }
  } else if (identity.name) {
    jsonLd.push(buildLocalBusinessJsonLd(identity))
  }

  // ---- Service ----
  if (row.tableSlug === 'services') {
    jsonLd.push(
      buildServiceJsonLd({
        name: pageTitle,
        ...(pick(text(row.cells.seoDescription), text(row.cells.heroSubtext))
          ? { description: pick(text(row.cells.seoDescription), text(row.cells.heroSubtext)) }
          : {}),
        ...(city ? { serviceType: pageTitle, areaServed: state ? `${city}, ${state}` : city } : { serviceType: pageTitle }),
        ...(canonical ? { url: canonical } : {}),
        ...(identity.name ? { provider: identity } : {}),
      }),
    )
  }

  // ---- FAQ (any table that carries an `faqs` cell) ----
  const faqs = parseFaqCell(row.cells.faqs)
  if (faqs.length > 0) jsonLd.push(buildFaqJsonLd(faqs))

  // ---- BreadcrumbList ----
  if (siteUrl) {
    const routeBase =
      row.tableRouteBase && row.tableRouteBase !== '/' ? row.tableRouteBase : undefined
    const stack = buildBreadcrumbStackForPage({
      siteName: identity.name,
      tableLabel: humanizeSlug(row.tableSlug),
      tableSlug: row.tableSlug,
      ...(routeBase ? { tableRouteBase: routeBase } : {}),
      pageSlug: row.slug,
      pageTitle,
    })
    // The stack builder leaves the current-page crumb URL-less and the
    // JSON-LD builder drops URL-less crumbs. Give the final crumb the
    // canonical URL so the breadcrumb ends at the current page — the
    // pattern Google's BreadcrumbList docs document (Home > Section > Page).
    const lastCrumb = stack[stack.length - 1]
    if (lastCrumb && canonical) lastCrumb.url = canonical
    const breadcrumb = buildBreadcrumbJsonLd(siteUrl, stack)
    if (breadcrumb) jsonLd.push(breadcrumb)
  }

  return jsonLd
}

/**
 * Plain page-tree pages: site-level LocalBusiness (when the publisher
 * identity is configured) + RSS feed discovery. Per-page fields stay with
 * the site's own metaTitle/metaDescription defaults — page-tree pages have
 * no per-entry SEO cells.
 */
export async function buildSiteDocumentMeta(
  ctx: SeoRenderContext,
): Promise<DocumentMetaOverride> {
  const { publisherIdentity } = await loadSiteSeoContext(ctx.db)
  const jsonLd: unknown[] = []
  if (publisherIdentity.name) jsonLd.push(buildLocalBusinessJsonLd(publisherIdentity))
  return {
    ...(ctx.rssFeedUrl ? { rssFeedUrl: ctx.rssFeedUrl } : {}),
    ...(jsonLd.length > 0 ? { jsonLd } : {}),
  }
}

/**
 * Parse the starter's `faqs` long-text cell: one FAQ per line, pipe-separated
 * (`Question | Answer`). Lines without a pipe, or with an empty half, are
 * dropped — a half-filled FAQ editor must never emit empty Question rows.
 */
export function parseFaqCell(cell: unknown): FaqItem[] {
  if (typeof cell !== 'string') return []
  const items: FaqItem[] = []
  for (const line of cell.split(/\r?\n/)) {
    const separator = line.indexOf('|')
    if (separator === -1) continue
    const question = line.slice(0, separator).trim()
    const answer = line.slice(separator + 1).trim()
    if (question && answer) items.push({ question, answer })
  }
  return items
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function pick(...values: string[]): string {
  for (const value of values) if (value) return value
  return ''
}

/** `cities` → `Cities`, `service-areas` → `Service Areas`. */
function humanizeSlug(slug: string): string {
  return slug
    .split(/[-_]+/)
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(' ')
}
