/**
 * SEO surface loaders and resolvers (Phase 1.5, GRAAAAA-69, plan D7).
 *
 * Pure helpers the publish path calls between snapshot assembly and
 * renderer entry:
 *
 *   loadSiteSeoContext(db)       — one round-trip that returns the SEO
 *                                  surface the render path needs:
 *                                  site URL, default OG image, publisher
 *                                  identity, and the typed SeoSettings.
 *
 *   resolveEntryDocumentMeta     — merge per-entry SEO cells with the
 *                                  template default + site settings into
 *                                  the DocumentMetaOverride the renderer
 *                                  expects. The same helper powers the
 *                                  baker (where it stamps every published
 *                                  page's <head>) and the live preview path.
 *
 *   buildBreadcrumbStackForPage  — derive a BreadcrumbList stack from the
 *                                  page's table slug + breadcrumb cells.
 *                                  City Landing pages get / > city stack;
 *                                  blog posts get / > /blog > post stack;
 *                                  Service pages get / > service stack.
 */

import type { DbClient } from '../../../server/db/client'
import { getSiteSeoSettings, getPublisherIdentity } from '../../../server/repositories/seo'
import type { SeoSettings, PublisherIdentity } from './types'
import type { BreadcrumbItem } from './types'
import type { DataRowCells } from '../data/schemas'
import type { DocumentMetaOverride } from '../publisher'
import { interpolateTokens } from '../templates/tokenInterpolation'
import { resolveCanonicalUrl } from './canonical'

export interface SiteSeoContext {
  settings: SeoSettings
  publisherIdentity: PublisherIdentity
}

export async function loadSiteSeoContext(db: DbClient): Promise<SiteSeoContext> {
  const [settings, publisherIdentity] = await Promise.all([
    getSiteSeoSettings(db),
    getPublisherIdentity(db),
  ])
  return { settings, publisherIdentity }
}

/**
 * Resolve the DocumentMetaOverride for one page.
 *
 * Fallback chain (per field):
 *
 *   per-entry cell → template default → site settings → empty
 *
 * The site's `siteUrl` is used to construct absolute URLs for OG/canonical
 * when the entry only carries a slug path. Token interpolation runs at the
 * end so an authored pattern like `{currentEntry.name} | Acme` still
 * resolves per-entry.
 */
export interface EntrySeoInput {
  cells: DataRowCells
  page: {
    title: string
    slug: string
    kind: 'page' | 'entry'
  }
  tableSlug: string
  tableRouteBase?: string
  templateContext: Record<string, unknown>
  siteSeoContext: SiteSeoContext
  /**
   * Optional per-template defaults. The Service Page template supplies
   * ogType='website' + defaultChangeFreq='monthly'; the Blog Post template
   * supplies ogType='article' + defaultChangeFreq='weekly'.
   */
  templateDefaults?: Partial<DocumentMetaOverride>
  /**
   * Optional breadcrumb stack. When omitted, the helper derives one from
   * `tableSlug` + `page.slug`. Callers can pass a custom stack when the
   * template knows better (e.g. a "Services by City" template might
   * include /services in the stack).
   */
  breadcrumbStack?: BreadcrumbItem[]
}

export function resolveEntryDocumentMeta(input: EntrySeoInput): DocumentMetaOverride {
  const cells = input.cells ?? {}
  const template = input.templateDefaults ?? {}
  const site = input.siteSeoContext.settings

  // ---- per-field fallback chain ---------------------------------------

  const title = pickString([
    cells.seoTitle,
    cells.metaTitle,
    template.title,
    input.page.title,
    site.siteUrl ? undefined : input.page.title, // never empty
  ])

  const description = pickString([
    cells.seoDescription,
    cells.metaDescription,
    cells.summary,
    cells.excerpt,
    template.description,
    interpolateTokens(input.cells.body?.toString?.() ?? '', input.templateContext as never),
  ])

  const canonicalUrl =
    typeof cells.canonicalUrl === 'string' && cells.canonicalUrl
      ? cells.canonicalUrl
      : resolveCanonicalUrl({
          siteUrl: site.siteUrl,
          slug: input.page.slug,
          routeBase: input.tableRouteBase,
          // Entries live under their table's routeBase (/cities/worcester);
          // only top-level pages canonicalize to /<slug>. Omitting this
          // collapsed every city/service entry onto a bogus top-level URL.
          isEntry: input.page.kind === 'entry',
        })

  const ogTitle = pickString([cells.ogTitle, cells.seoTitle, title])
  const ogDescription = pickString([cells.ogDescription, cells.seoDescription, description])
  const ogImage = pickImage([cells.ogImage, site.defaultOgImage])
  const ogType = pickString([cells.ogType, template.ogType, input.page.kind === 'page' ? 'website' : 'article'])

  const twitterCard = pickString([cells.twitterCard, template.twitterCard, 'summary_large_image'])
  const twitterImage = pickImage([cells.twitterImage, ogImage])

  const noindex = cells.noindex === true || template.noindex === true
  const excludeFromSitemap = cells.excludeFromSitemap === true || template.excludeFromSitemap === true

  const schemaPriority = clampNumber(
    pickNumber([cells.schemaPriority, template.schemaPriority, site.defaultPriority]),
    0,
    1,
  )
  const schemaChangeFreq = pickString([
    cells.schemaChangeFreq,
    template.schemaChangeFreq,
    site.defaultChangeFreq,
    'weekly',
  ])

  return {
    title,
    description,
    canonicalUrl,
    ogTitle,
    ogDescription,
    ogImage,
    ogType,
    twitterCard,
    twitterImage,
    noindex,
    excludeFromSitemap,
    schemaPriority,
    schemaChangeFreq,
  }
}

/**
 * Pick the first non-empty value in a fallback chain.
 */
function pickString(values: Array<unknown>): string {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v
  }
  return ''
}

function pickNumber(values: Array<unknown>): number | undefined {
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && v.trim()) {
      const n = Number.parseFloat(v)
      if (Number.isFinite(n)) return n
    }
  }
  return undefined
}

function pickImage(values: Array<unknown>): string | null {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v
  }
  return null
}

function clampNumber(n: number | undefined, min: number, max: number): number {
  if (n === undefined || !Number.isFinite(n)) return (min + max) / 2
  return Math.max(min, Math.min(max, n))
}

/**
 * Default breadcrumb stack for a page: / > table > current page.
 * Caller can override when the template has a specific structure.
 */
export function buildBreadcrumbStackForPage(input: {
  siteName: string
  tableLabel: string
  tableSlug: string
  tableRouteBase?: string
  pageSlug: string
  pageTitle: string
}): BreadcrumbItem[] {
  const stack: BreadcrumbItem[] = []
  if (input.tableRouteBase) {
    stack.push({ name: input.tableLabel, url: input.tableRouteBase })
  } else if (input.tableSlug !== 'pages') {
    stack.push({ name: input.tableLabel, url: `/${input.tableSlug}` })
  }
  stack.push({ name: input.pageTitle, url: '' })
  return stack
}
