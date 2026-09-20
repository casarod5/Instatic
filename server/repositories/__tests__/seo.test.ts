/**
 * Phase 1.5 (GRAAAAA-69) repository tests: site_redirects CRUD + CSV
 * import/export roundtrip, and SEO settings / publisher identity /
 * robots.txt persistence. In-memory SQLite + full migrations, matching the
 * other repository test suites.
 */
import { describe, expect, it, beforeEach } from 'bun:test'
import { createSqliteClient } from '../../db/sqlite'
import { sqliteMigrations } from '../../db/migrations-sqlite'
import { runMigrations } from '../../db/runMigrations'
import type { DbClient } from '../../db/client'
import {
  createSiteRedirect,
  deleteAllSiteRedirects,
  deleteSiteRedirect,
  exportRedirectsCsv,
  getRobotsTxt,
  getSiteRedirectByPath,
  getSiteRedirectById,
  getSiteSeoSettings,
  importRedirectsCsv,
  listEnabledSiteRedirects,
  listSiteRedirects,
  setPublisherIdentity,
  setRobotsTxt,
  setSiteSeoSettings,
  updateSiteRedirect,
} from '../seo'

async function freshDb(): Promise<DbClient> {
  const db = createSqliteClient(':memory:')
  await runMigrations(db, sqliteMigrations)
  return db
}

describe('site_redirects CRUD', () => {
  let db: DbClient

  beforeEach(async () => {
    db = await freshDb()
  })

  it('creates a redirect with 301 default and reads it back by path', async () => {
    const row = await createSiteRedirect(db, {
      fromPath: '/old-page',
      targetPath: '/new-page',
    })
    expect(row.statusCode).toBe(301)
    expect(row.enabled).toBe(true)
    expect(row.isRegex).toBe(false)
    expect(row.hitCount).toBe(0)

    const byPath = await getSiteRedirectByPath(db, '/old-page')
    expect(byPath?.id).toBe(row.id)
    expect(byPath?.targetPath).toBe('/new-page')
  })

  it('upserts on the same enabled from_path instead of duplicating', async () => {
    await createSiteRedirect(db, { fromPath: '/dup', targetPath: '/a' })
    const second = await createSiteRedirect(db, { fromPath: '/dup', targetPath: '/b' })
    const all = await listSiteRedirects(db)
    expect(all).toHaveLength(1)
    expect(all[0].targetPath).toBe('/b')
    expect(second.id).toBe(all[0].id)
  })

  it('updates by id and deletes by id', async () => {
    const row = await createSiteRedirect(db, { fromPath: '/x', targetPath: '/y' })
    const updated = await updateSiteRedirect(db, {
      id: row.id,
      targetPath: '/z',
      enabled: false,
    })
    expect(updated?.targetPath).toBe('/z')
    expect(updated?.enabled).toBe(false)
    // Disabled rows drop out of the enabled listing.
    expect(listEnabledSiteRedirects(db)).resolves.toHaveLength(0)

    await deleteSiteRedirect(db, row.id)
    expect(await getSiteRedirectById(db, row.id)).toBeNull()
  })
})

describe('redirects CSV import/export', () => {
  let db: DbClient

  beforeEach(async () => {
    db = await freshDb()
  })

  it('imports rows, counts skipped errors, and honours replace mode', async () => {
    const csv = [
      'from,target,status,regex,enabled,note',
      '/wp/old,/services,301,false,true,WP migration',
      '/missing-target,,301,false,true,',
      '/bad-status,/x,999,false,true,',
      '/promo,https://example.com/promo,302,false,false,Seasonal',
    ].join('\n')

    const result = await importRedirectsCsv(db, csv)
    expect(result.inserted).toBe(2)
    expect(result.errors).toHaveLength(2)
    expect(result.errors.map((e) => e.reason).sort()).toEqual([
      'Invalid status code',
      'Missing from or target',
    ])

    // Re-import with replace=true wipes the table first.
    const replace = await importRedirectsCsv(db, '/only,/one', { replace: true })
    expect(replace.inserted).toBe(1)
    const all = await listSiteRedirects(db)
    expect(all).toHaveLength(1)
    expect(all[0].fromPath).toBe('/only')
  })

  it('roundtrips import → export → fresh import with identical rows', async () => {
    await importRedirectsCsv(db, [
      'from,target,status,regex,enabled,note',
      '/a,/b,301,false,true,First',
      '/c,/d,308,true,true,"Quoted, note"',
    ].join('\n'))

    const csv = await exportRedirectsCsv(db)
    const fresh = await freshDb()
    const back = await importRedirectsCsv(fresh, csv)
    expect(back.inserted).toBe(2)

    const original = await listSiteRedirects(db)
    const restored = await listSiteRedirects(fresh)
    expect(restored.map((r) => [r.fromPath, r.targetPath, r.statusCode, r.isRegex, r.note]))
      .toEqual(original.map((r) => [r.fromPath, r.targetPath, r.statusCode, r.isRegex, r.note]))
  })

  it('deleteAllSiteRedirects clears the table', async () => {
    await createSiteRedirect(db, { fromPath: '/a', targetPath: '/b' })
    await createSiteRedirect(db, { fromPath: '/c', targetPath: '/d' })
    await deleteAllSiteRedirects(db)
    expect(await listSiteRedirects(db)).toHaveLength(0)
  })
})

describe('SEO settings / identity / robots persistence', () => {
  let db: DbClient

  beforeEach(async () => {
    db = await freshDb()
  })

  it('returns defaults before any set and merges partial patches', async () => {
    const defaults = await getSiteSeoSettings(db)
    expect(defaults.siteUrl).toBe('')

    const patched = await setSiteSeoSettings(db, {
      siteUrl: 'https://granite.example.com',
      orgName: 'Granite Works',
    })
    expect(patched.siteUrl).toBe('https://granite.example.com')

    const again = await setSiteSeoSettings(db, { twitterHandle: '@granite' })
    expect(again.siteUrl).toBe('https://granite.example.com')
    expect(again.twitterHandle).toBe('@granite')
  })

  it('merges publisher identity patches and persists robots.txt', async () => {
    const identity = await setPublisherIdentity(db, {
      name: 'Granite Works',
      telephone: '+1-508-555-0142',
    })
    expect(identity.name).toBe('Granite Works')

    const more = await setPublisherIdentity(db, { email: 'hi@granite.example.com' })
    expect(more.telephone).toBe('+1-508-555-0142')
    expect(more.email).toBe('hi@granite.example.com')

    const body = 'User-agent: *\nAllow: /\n'
    expect(await setRobotsTxt(db, body)).toBe(body)
    expect(await getRobotsTxt(db)).toBe(body)
  })
})
