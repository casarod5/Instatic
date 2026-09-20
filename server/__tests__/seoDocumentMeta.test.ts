/**
 * Phase 1.5 (GRAAAAA-69) tests for the per-page SEO document-meta
 * assembler: per-city LocalBusiness for City Landing rows, Service + FAQ
 * for Service rows, BreadcrumbList emission, FAQ cell parsing, and the
 * empty-site no-op guarantee (byte-identical head when nothing is
 * configured). In-memory SQLite + full migrations, matching the other
 * repository test suites.
 */
import { describe, expect, it, beforeEach } from 'bun:test'
import { createSqliteClient } from '../db/sqlite'
import { sqliteMigrations } from '../db/migrations-sqlite'
import { runMigrations } from '../db/runMigrations'
import type { DbClient } from '../db/client'
import { setPublisherIdentity, setSiteSeoSettings } from '../repositories/seo'
import {
  assembleDataRowJsonLd,
  buildDataRowDocumentMeta,
  buildSiteDocumentMeta,
  parseFaqCell,
} from '../publish/seoDocumentMeta'
import type { PublishedDataRow } from '@core/data/schemas'
import type { PublisherIdentity } from '@core/seo/types'

function makeRow(overrides: Record<string, unknown> = {}): PublishedDataRow {
  return {
    id: 'pr-1',
    rowId: 'row-1',
    tableId: 't-1',
    tableSlug: 'cities',
    tableKind: 'postType',
    tableRouteBase: '/cities',
    versionNumber: 1,
    cells: {},
    slug: 'worcester',
    featuredMediaId: null,
    featuredMediaPath: null,
    authorUserId: null,
    authorName: null,
    authorRoleSlug: null,
    authorRoleName: null,
    publishedByUserId: null,
    publishedByName: null,
    publishedByRoleSlug: null,
    publishedByRoleName: null,
    publishedAt: '2026-09-20T00:00:00.000Z',
    createdAt: '2026-09-20T00:00:00.000Z',
    ...overrides,
  } as PublishedDataRow
}

const IDENTITY: PublisherIdentity = {
  name: 'Granite Plumbing & Drain',
  telephone: '+1-508-555-0100',
  address: {
    '@type': 'PostalAddress',
    streetAddress: '100 Main St',
    addressLocality: 'Worcester',
    addressRegion: 'MA',
    postalCode: '01608',
    addressCountry: 'US',
  },
}

function byType(jsonLd: unknown[] | undefined, type: string): Record<string, any> | undefined {
  return (jsonLd ?? []).find(
    (payload) => (payload as Record<string, unknown>)?.['@type'] === type,
  ) as Record<string, any> | undefined
}

describe('parseFaqCell', () => {
  it('parses one FAQ per pipe-separated line', () => {
    const items = parseFaqCell('Do you offer 24/7 service? | Yes, round the clock.\nHow fast? | Same day.')
    expect(items).toEqual([
      { question: 'Do you offer 24/7 service?', answer: 'Yes, round the clock.' },
      { question: 'How fast?', answer: 'Same day.' },
    ])
  })

  it('drops malformed lines and non-string cells', () => {
    expect(parseFaqCell('no pipe here\n | \nQ | ')).toEqual([])
    expect(parseFaqCell(42)).toEqual([])
    expect(parseFaqCell(undefined)).toEqual([])
  })
})

describe('assembleDataRowJsonLd', () => {
  it('emits one per-city LocalBusiness with NAP overridden from typed fields', () => {
    const row = makeRow({
      cells: { title: 'Worcester', state: 'MA', phone: '+1-508-555-0199' },
    })
    const jsonLd = assembleDataRowJsonLd({
      row,
      pageTitle: 'Worcester',
      canonical: 'https://example.com/cities/worcester',
      identity: IDENTITY,
      siteUrl: 'https://example.com',
    })

    const businesses = jsonLd.filter((p) => (p as Record<string, unknown>)?.['@type'] === 'LocalBusiness')
    expect(businesses).toHaveLength(1)
    const business = businesses[0] as Record<string, any>
    expect(business.name).toBe('Granite Plumbing & Drain — Worcester')
    expect(business.telephone).toBe('+1-508-555-0199')
    expect(business.address.addressLocality).toBe('Worcester')
    expect(business.address.addressRegion).toBe('MA')
    expect(business.address.streetAddress).toBe('100 Main St')
    expect(business.areaServed).toBe('Worcester, MA')
    expect(business.url).toBe('https://example.com/cities/worcester')

    const breadcrumb = byType(jsonLd, 'BreadcrumbList')
    expect(breadcrumb).toBeDefined()
    const names = breadcrumb!.itemListElement.map((item: any) => item.name)
    expect(names).toEqual(['Home', 'Cities', 'Worcester'])
  })

  it('emits Service + FAQ + site LocalBusiness for service rows', () => {
    const row = makeRow({
      tableSlug: 'services',
      tableRouteBase: '/services',
      slug: 'drain-cleaning',
      cells: {
        title: 'Drain Cleaning',
        heroSubtext: 'Fast, local, guaranteed.',
        faqs: 'Do you snake main lines? | Yes, up to 100 ft.\nmalformed\nHow fast? | Same day.',
      },
    })
    const jsonLd = assembleDataRowJsonLd({
      row,
      pageTitle: 'Drain Cleaning',
      canonical: 'https://example.com/services/drain-cleaning',
      identity: IDENTITY,
      siteUrl: 'https://example.com',
    })

    const business = byType(jsonLd, 'LocalBusiness')
    expect(business?.name).toBe('Granite Plumbing & Drain') // site default, no city suffix

    const service = byType(jsonLd, 'Service')
    expect(service?.name).toBe('Drain Cleaning')
    expect(service?.description).toBe('Fast, local, guaranteed.')
    expect((service?.provider as Record<string, any>)?.name).toBe('Granite Plumbing & Drain')

    const faq = byType(jsonLd, 'FAQPage')
    expect(faq?.mainEntity).toHaveLength(2)
    expect(faq?.mainEntity[0].name).toBe('Do you snake main lines?')

    const breadcrumb = byType(jsonLd, 'BreadcrumbList')
    expect(breadcrumb?.itemListElement.map((i: any) => i.name)).toEqual([
      'Home',
      'Services',
      'Drain Cleaning',
    ])
  })

  it('emits nothing when no identity, no site URL, and no city fields', () => {
    const row = makeRow({ cells: {} })
    const jsonLd = assembleDataRowJsonLd({
      row,
      pageTitle: 'worcester',
      canonical: '',
      identity: {} as PublisherIdentity,
      siteUrl: '',
    })
    expect(jsonLd).toEqual([])
  })
})

describe('buildDataRowDocumentMeta / buildSiteDocumentMeta (db-backed)', () => {
  let db: DbClient

  beforeEach(async () => {
    db = createSqliteClient(':memory:')
    await runMigrations(db, sqliteMigrations)
  })

  it('resolves the full per-entry surface with the cell → template → site fallback chain', async () => {
    await setSiteSeoSettings(db, { siteUrl: 'https://example.com' })
    await setPublisherIdentity(db, IDENTITY)

    const row = makeRow({
      cells: { title: 'Worcester', state: 'MA', seoTitle: 'Plumber in Worcester MA | Same-Day', seoDescription: 'Local crews, flat rates.' },
    })
    const meta = await buildDataRowDocumentMeta(row, { db, rssFeedUrl: 'https://example.com/feed.xml' })

    expect(meta.title).toBe('Plumber in Worcester MA | Same-Day')
    expect(meta.description).toBe('Local crews, flat rates.')
    expect(meta.canonicalUrl).toBe('https://example.com/cities/worcester')
    expect(meta.ogTitle).toBe('Plumber in Worcester MA | Same-Day')
    expect(meta.twitterCard).toBe('summary_large_image')
    expect(meta.ogType).toBe('website') // cities template default
    expect(meta.rssFeedUrl).toBe('https://example.com/feed.xml')
    expect(byType(meta.jsonLd, 'LocalBusiness')?.name).toBe('Granite Plumbing & Drain — Worcester')
  })

  it('returns an empty override when nothing is configured (byte-identical head)', async () => {
    const row = makeRow({ cells: {} })
    const meta = await buildDataRowDocumentMeta(row, { db })
    expect(meta.jsonLd).toBeUndefined()
    expect(meta.canonicalUrl).toBe('')
    expect(meta.rssFeedUrl).toBeUndefined()

    const siteMeta = await buildSiteDocumentMeta({ db })
    expect(siteMeta.jsonLd).toBeUndefined()
  })

  it('site meta carries feed discovery + site LocalBusiness only', async () => {
    await setPublisherIdentity(db, IDENTITY)
    const siteMeta = await buildSiteDocumentMeta({ db, rssFeedUrl: 'https://example.com/feed.xml' })
    expect(siteMeta.rssFeedUrl).toBe('https://example.com/feed.xml')
    expect(byType(siteMeta.jsonLd, 'LocalBusiness')?.name).toBe('Granite Plumbing & Drain')
    expect(byType(siteMeta.jsonLd, 'Service')).toBeUndefined()
  })
})
