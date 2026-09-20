/**
 * SEO & redirects types (Phase 1.5, GRAAAAA-69, plan D7).
 *
 * Shared by the publisher (server/publish), the public router
 * (server/publish/publicRouter.ts), the admin CMS handlers
 * (server/handlers/cms/seo.ts), and the seed script.
 *
 * `site.seo_settings_json` shape (one row, single default site):
 *
 *   {
 *     siteUrl: string,                    // e.g. "https://granitecrm.com"
 *     defaultOgImage: string | null,      // absolute or site-relative URL
 *     robotsTxt: string,                  // raw robots.txt body
 *     sitemapExtraPaths: string[],        // extra paths to list in sitemap
 *     defaultChangeFreq: string,          // "daily"|"weekly"|"monthly"|"yearly"
 *     defaultPriority: number,             // 0..1
 *     excludeAdminPaths: boolean,         // mirror into robots.txt disallow
 *   }
 *
 * `site.publisher_identity_json` shape — the LocalBusiness / Organization
 * JSON-LD used when a page doesn't override it. (City Landing emits its own
 * per-city LocalBusiness on top of this base NAP.)
 *
 *   {
 *     "@context": "https://schema.org",
 *     "@type": "LocalBusiness",
 *     "name": string,
 *     "legalName"?: string,
 *     "url"?: string,
 *     "logo"?: string,
 *     "image"?: string,
 *     "telephone"?: string,
 *     "email"?: string,
 *     "priceRange"?: string,
 *     "address": { "@type": "PostalAddress", streetAddress, addressLocality,
 *                  addressRegion, postalCode, addressCountry },
 *     "geo"?: { "@type": "GeoCoordinates", latitude, longitude },
 *     "openingHours"?: string[],          // ["Mo-Fr 09:00-17:00"]
 *     "sameAs"?: string[],                // social profile URLs
 *   }
 *
 * `site_redirects` table row (per-row 301/302/307/308 manual redirects —
 * independent of the existing `data_row_redirects` which only tracks
 * slug-rename history for content rows):
 *
 *   { id, fromPath, targetPath, statusCode, isRegex, enabled, source, note,
 *     hitCount, lastHitAt, createdAt, updatedAt }
 */

import { Type, type Static } from '@sinclair/typebox'

// ---------------------------------------------------------------------------
// Site settings
// ---------------------------------------------------------------------------

export const SeoSettingsSchema = Type.Object({
  siteUrl: Type.String({ default: '' }),
  defaultOgImage: Type.Union([Type.String(), Type.Null()], { default: null }),
  robotsTxt: Type.String({ default: '' }),
  sitemapExtraPaths: Type.Array(Type.String(), { default: () => [] }),
  defaultChangeFreq: Type.String({ default: 'weekly' }),
  defaultPriority: Type.Number({ default: 0.5, minimum: 0, maximum: 1 }),
  excludeAdminPaths: Type.Boolean({ default: true }),
  /**
   * Enable RSS 2.0 feed at /feed.xml (blog posts only, published +
   * noindex=false, newest 50). Source of truth lives on `SiteSettings` so
   * the admin UI can edit it through the existing site-settings controller;
   * this column carries the mirrored value for the publish + route paths
   * that load `site.seo_settings_json` directly.
   */
  enableRssFeed: Type.Boolean({ default: true }),
})

export type SeoSettings = Static<typeof SeoSettingsSchema>

export const PostalAddressSchema = Type.Object({
  '@type': Type.Literal('PostalAddress'),
  streetAddress: Type.String(),
  addressLocality: Type.String(),
  addressRegion: Type.String(),
  postalCode: Type.String(),
  addressCountry: Type.String({ default: 'US' }),
})

export const GeoCoordinatesSchema = Type.Object({
  '@type': Type.Literal('GeoCoordinates'),
  latitude: Type.Number(),
  longitude: Type.Number(),
})

/**
 * Loose schema — `publisher_identity_json` is a JSON-LD blob. We accept any
 * well-formed object so admins can extend with custom schema.org properties
 * (aggregateRating, areaServed, hasOfferCatalog, etc.) without us pinning
 * every property up front. The publisher always re-emits the row through
 * `JSON.stringify` so it stays valid JSON-LD.
 */
export const PublisherIdentitySchema = Type.Object({
  '@context': Type.Optional(Type.String()),
  '@type': Type.Optional(Type.String()),
  name: Type.String({ default: '' }),
  legalName: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()),
  logo: Type.Optional(Type.String()),
  image: Type.Optional(Type.String()),
  telephone: Type.Optional(Type.String()),
  email: Type.Optional(Type.String()),
  priceRange: Type.Optional(Type.String()),
  address: Type.Optional(PostalAddressSchema),
  geo: Type.Optional(GeoCoordinatesSchema),
  openingHours: Type.Optional(Type.Array(Type.String())),
  sameAs: Type.Optional(Type.Array(Type.String())),
  // Escape hatch — anything else is preserved verbatim.
})

export type PublisherIdentity = Static<typeof PublisherIdentitySchema> & Record<string, unknown>

// ---------------------------------------------------------------------------
// Site redirect record
// ---------------------------------------------------------------------------

export const RedirectStatusCodes = [301, 302, 307, 308] as const
export type RedirectStatusCode = (typeof RedirectStatusCodes)[number]

export const SiteRedirectRowSchema = Type.Object({
  id: Type.String(),
  fromPath: Type.String(),
  targetPath: Type.String(),
  statusCode: Type.Integer({ minimum: 301, maximum: 308 }),
  isRegex: Type.Boolean(),
  enabled: Type.Boolean(),
  source: Type.String(),
  note: Type.String(),
  hitCount: Type.Integer(),
  lastHitAt: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
})

export type SiteRedirectRow = Static<typeof SiteRedirectRowSchema>

// ---------------------------------------------------------------------------
// Per-page document meta — extends the existing DocumentMetaOverride
// ---------------------------------------------------------------------------

/**
 * What the publisher emits into <head> for one page. Extends the existing
 * `DocumentMetaOverride` in `@core/publisher` with the full SEO surface.
 *
 * Fields fall through the chain:
 *   per-page cell → template default → site SEO settings → empty
 */
export interface ResolvedDocumentMeta {
  title: string
  description: string
  canonicalUrl: string
  ogTitle: string
  ogDescription: string
  ogImage: string | null
  ogType: string
  twitterCard: string
  twitterImage: string | null
  noindex: boolean
  excludeFromSitemap: boolean
  schemaPriority: number
  schemaChangeFreq: string
}

// ---------------------------------------------------------------------------
// JSON-LD shapes used by structured-data emitters
// ---------------------------------------------------------------------------

export interface LocalBusinessPayload extends PublisherIdentity {
  '@context': 'https://schema.org'
  '@type': 'LocalBusiness'
}

export interface ServicePayload {
  '@context': 'https://schema.org'
  '@type': 'Service'
  name: string
  description?: string
  provider?: unknown
  areaServed?: unknown
  serviceType?: string
  url?: string
  image?: string
}

export interface FaqItem {
  question: string
  answer: string
}

export interface FaqPayload {
  '@context': 'https://schema.org'
  '@type': 'FAQPage'
  mainEntity: Array<{
    '@type': 'Question'
    name: string
    acceptedAnswer: { '@type': 'Answer'; text: string }
  }>
}

export interface BreadcrumbItem {
  name: string
  url: string
}

export interface BreadcrumbPayload {
  '@context': 'https://schema.org'
  '@type': 'BreadcrumbList'
  itemListElement: Array<{
    '@type': 'ListItem'
    position: number
    name: string
    item: string
  }>
}

// ---------------------------------------------------------------------------
// Sitemap entries
// ---------------------------------------------------------------------------

export interface SitemapEntry {
  loc: string                  // absolute URL
  lastmod?: string             // ISO 8601 date
  changefreq?: string          // "daily" | "weekly" | ...
  priority?: number            // 0..1
}

// ---------------------------------------------------------------------------
// Choreography
// ---------------------------------------------------------------------------

/**
 * Steps the post-publish choreography fires, in order. Each step has a
 * `kind` that the dispatcher maps to a side-effect (HTTP purge, sitemap
 * ping, audit-log write). Steps are idempotent: re-running the choreography
 * for the same `publishId` is a no-op against the audit log, and HTTP
 * endpoints accept repeat POSTs without compounding state.
 */
export type ChoreographyStep =
  | { kind: 'cloudflare-purge'; zoneId: string; }
  | { kind: 'sitemap-ping'; searchEngines?: Array<'google' | 'bing'>; }
  | { kind: 'audit-log'; action: string; }

export interface ChoreographyConfig {
  steps: ChoreographyStep[]
  /** When true, the choreography fails the publish on a step failure. Default false (warn-only). */
  required?: boolean
}

export interface ChoreographyResult {
  publishId: string
  startedAt: string
  finishedAt: string
  steps: Array<{
    kind: ChoreographyStep['kind']
    status: 'ok' | 'failed' | 'skipped'
    detail: string
    durationMs: number
  }>
}
