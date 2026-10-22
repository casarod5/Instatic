/**
 * GRAAAAA-65 — the sitemap must advertise exactly the routable URL set.
 *
 * Regression test for the SEO-integrity defect where `/sitemap.xml` listed
 * template pages. A template page is an entry renderer, not a URL: the public
 * router refuses it (`isTemplatePage` guard in publicRouter) and the bake path
 * skips it (`isTemplatePage` guard in seoChoreography). Only the live collector
 * in `collectLivePages` emitted them, so the sitemap handed crawlers a set of
 * guaranteed-404 URLs. On granitecrm.com staging that surfaced as four `/tpl-*`
 * entries that hard-404ed — previously masked by hand-set `excludeFromSitemap`
 * data flags rather than the code that was wrong.
 *
 * These tests pin the live route's output to the routable set, so the flags
 * cannot be load-bearing again.
 */
import { describe, expect, it } from 'bun:test'
import type { DbResult } from '../../../server/db'
import { tryServeSitemap } from '../../../server/publish/seoRoutes'
import type { ServerRuntime } from '../../../server/runtime'
import { createFakeDb } from './dbTestFake'

const PUBLISHED_AT = '2026-10-01T00:00:00.000Z'
const SITE_URL = 'https://staging.granitecrm.com'

interface FakePageRow {
  slug: string
  cells: Record<string, unknown>
  publishedAt: string | null
}

interface FakeTableRow {
  logical_id: string
  name: string
  slug: string
  kind: string
  route_base: string
  singular_label: string
  plural_label: string
  primary_field_id: string
  fields_json: unknown[]
  system: number
}

const pagesTable: FakeTableRow = {
  logical_id: 'pages',
  name: 'Pages',
  slug: 'pages',
  kind: 'page',
  route_base: '',
  singular_label: 'Page',
  plural_label: 'Pages',
  primary_field_id: 'title',
  // Mirrors the seeded `pages` field list — `templateEnabled` is the stored
  // form of `page.template.enabled` (core/data/pageFromRow).
  fields_json: [
    { type: 'text', id: 'title', label: 'Title', required: true, builtIn: true },
    { type: 'text', id: 'slug', label: 'Slug', required: true, builtIn: true },
    { type: 'pageTree', id: 'body', label: 'Body', required: true, builtIn: true },
    { type: 'boolean', id: 'templateEnabled', label: 'Template', builtIn: true },
    { type: 'longText', id: 'templateTarget', label: 'Template target', builtIn: true },
  ],
  system: 0,
}

/**
 * The page rows one publish would leave behind: two real pages and two entry
 * templates. `tpl-*` is the slug prefix the seeded templates ship with.
 */
const pageRows: FakePageRow[] = [
  { slug: 'index', cells: { title: 'Home' }, publishedAt: PUBLISHED_AT },
  { slug: 'about', cells: { title: 'About' }, publishedAt: PUBLISHED_AT },
  {
    slug: 'tpl-service',
    cells: { title: 'Service entry', templateEnabled: true, templateTarget: '/services' },
    publishedAt: PUBLISHED_AT,
  },
  {
    slug: 'tpl-case-study',
    cells: { title: 'Case study entry', templateEnabled: true, templateTarget: '/work' },
    publishedAt: PUBLISHED_AT,
  },
]

function makeDb(rows: FakePageRow[] = pageRows) {
  return createFakeDb(async (rawSql, params): Promise<DbResult> => {
    const sql = rawSql.replace(/\s+/g, ' ').trim().toLowerCase()

    // getSiteSeoSettings — the settings row must carry a siteUrl or the route
    // short-circuits to an empty sitemap.
    if (sql.includes('from site where')) {
      return {
        rows: [{
          seo_settings_json: { siteUrl: SITE_URL },
          publisher_identity_json: null,
          sitemap_extra_paths_json: null,
          robots_txt: null,
        }],
        rowCount: 1,
      }
    }

    if (sql.includes('from data_tables')) {
      return {
        rows: [{
          ...pagesTable,
          created_by_user_id: null,
          updated_by_user_id: null,
          created_at: PUBLISHED_AT,
          updated_at: PUBLISHED_AT,
        }],
        rowCount: 1,
      }
    }

    // listDataRows — the hydrated select, filtered to the `pages` table.
    if (sql.includes('from data_rows')) {
      if (String(params[0]) !== 'pages') return { rows: [], rowCount: 0 }
      return {
        rows: rows.map((row, i) => ({
          logical_id: `row-${i}`,
          table_id: 'pages',
          cells_json: row.cells,
          slug: row.slug,
          status: row.publishedAt ? 'published' : 'draft',
          seq: i,
          author_user_id: null,
          created_by_user_id: null,
          updated_by_user_id: null,
          published_by_user_id: null,
          author_name: null,
          author_email: null,
          author_display_name: null,
          author_role_slug: null,
          author_role_name: null,
          created_by_name: null,
          created_by_email: null,
          created_by_display_name: null,
          created_by_role_slug: null,
          created_by_role_name: null,
          updated_by_name: null,
          updated_by_email: null,
          updated_by_display_name: null,
          updated_by_role_slug: null,
          updated_by_role_name: null,
          published_by_name: null,
          published_by_email: null,
          published_by_display_name: null,
          published_by_role_slug: null,
          published_by_role_name: null,
          created_at: PUBLISHED_AT,
          updated_at: PUBLISHED_AT,
          published_at: row.publishedAt,
          scheduled_publish_at: null,
          deleted_at: null,
        })),
        rowCount: rows.length,
      }
    }

    // listEnabledSiteRedirects
    if (sql.includes('from site_redirects')) return { rows: [], rowCount: 0 }

    return { rows: [], rowCount: 0 }
  })
}

async function fetchSitemap(rows?: FakePageRow[]): Promise<string> {
  const runtime = { db: makeDb(rows) } as unknown as ServerRuntime
  const url = new URL('https://staging.granitecrm.com/sitemap.xml')
  const res = await tryServeSitemap(new Request(url), runtime, url, '/sitemap.xml')
  if (!res) throw new Error('tryServeSitemap declined /sitemap.xml')
  return res.text()
}

describe('GET /sitemap.xml — routable URL set', () => {
  it('lists the published pages', async () => {
    const xml = await fetchSitemap()
    expect(xml).toContain(`${SITE_URL}/about`)
    expect(xml).toContain('<loc>https://staging.granitecrm.com/</loc>')
  })

  it('omits template pages — they are entry renderers and the router 404s them', async () => {
    const xml = await fetchSitemap()
    expect(xml).not.toContain('/tpl-service')
    expect(xml).not.toContain('/tpl-case-study')
  })

  it('still omits the notFound route', async () => {
    const xml = await fetchSitemap([
      { slug: 'index', cells: { title: 'Home' }, publishedAt: PUBLISHED_AT },
      { slug: 'notFound', cells: { title: 'Not found' }, publishedAt: PUBLISHED_AT },
    ])
    expect(xml).not.toContain('/notFound')
  })

  it('omits draft pages', async () => {
    const xml = await fetchSitemap([
      { slug: 'index', cells: { title: 'Home' }, publishedAt: PUBLISHED_AT },
      { slug: 'secret', cells: { title: 'Draft' }, publishedAt: null },
    ])
    expect(xml).not.toContain('/secret')
  })
})