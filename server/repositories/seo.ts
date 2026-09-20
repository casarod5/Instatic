/**
 * SEO & redirects repository (Phase 1.5, GRAAAAA-69, plan D7).
 *
 * Owns all SQL touching `site_redirects`, the new site-level SEO columns,
 * the publisher identity, and CSV import/export of redirects. Kept distinct
 * from `server/repositories/site.ts` (which owns `settings_json` / branches)
 * so the Phase 1.5 surface has a single home and a focused test surface.
 *
 *   listSiteRedirects        — every enabled-or-not redirect, ordered for admin tables
 *   getSiteRedirectByPath    — one redirect by `fromPath` (the public route lookup)
 *   listEnabledSiteRedirects — enabled redirects only, used by the publisher
 *                              to bake `301` headers into the static output
 *   createSiteRedirect       — manual create + CSV import
 *   updateSiteRedirect       — toggle enabled / change target
 *   deleteSiteRedirect       — manual delete (CSV replace-mode calls
 *                              `deleteAllSiteRedirects` + bulk `createSiteRedirect`)
 *   bulkInsertSiteRedirects  — CSV insert; uses one transaction
 *   recordSiteRedirectHit    — increments hit_count + last_hit_at for analytics
 *   parseRedirectsCsv        — parse a CSV into rows (delegates to
 *                              `@core/seo/csv`, kept here for one-stop importing)
 *
 *   getSiteSeoSettings       — read site.seo_settings_json (typed)
 *   setSiteSeoSettings       — write site.seo_settings_json
 *   getPublisherIdentity     — read site.publisher_identity_json (typed)
 *   setPublisherIdentity     — write site.publisher_identity_json
 *   getRobotsTxt / setRobotsTxt
 *
 * The site's row is unique (`id = 'default'`); every helper here locks to
 * that single row.
 */

import { nanoid } from 'nanoid'
import type { DbClient } from '../db/client'
import { nowIso } from '@core/utils/isoDate'
import {
  SeoSettingsSchema,
  PublisherIdentitySchema,
  type SeoSettings,
  type PublisherIdentity,
  RedirectStatusCodes,
  type RedirectStatusCode,
  type SiteRedirectRow,
} from '@core/seo/types'
import { parseRedirectsCsv } from '@core/seo/csv'
import { parseValue } from '@core/utils/typeboxHelpers'
import { siteRowId } from './site'
import { MAIN_SCOPE } from '../branches/scope'

// ---------------------------------------------------------------------------
// Internal row shapes
// ---------------------------------------------------------------------------

interface SiteRow {
  seo_settings_json: string
  publisher_identity_json: string
  sitemap_extra_paths_json: string
  robots_txt: string
}

interface SiteRedirectDbRow {
  id: string
  from_path: string
  target_path: string
  status_code: number
  is_regex: number
  enabled: number
  source: string
  note: string
  hit_count: number
  last_hit_at: string | null
  created_at: string
  updated_at: string
}

function rowToSiteRedirect(row: SiteRedirectDbRow): SiteRedirectRow {
  return {
    id: row.id,
    fromPath: row.from_path,
    targetPath: row.target_path,
    statusCode: row.status_code as RedirectStatusCode,
    isRegex: row.is_regex === 1,
    enabled: row.enabled === 1,
    source: row.source,
    note: row.note,
    hitCount: row.hit_count,
    lastHitAt: row.last_hit_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function readJsonSafe<T>(raw: unknown, fallback: T): T {
  // The db clients auto-parse `*_json` columns on read (client.ts), so `raw`
  // is usually an already-parsed object; tolerate raw TEXT too.
  if (raw == null || raw === '') return fallback
  if (typeof raw === 'object') return raw as T
  try {
    return JSON.parse(raw as string) as T
  } catch {
    return fallback
  }
}

// ---------------------------------------------------------------------------
// Site settings / publisher identity / robots
// ---------------------------------------------------------------------------

async function getSiteRow(db: DbClient): Promise<SiteRow | null> {
  const { rows } = await db<SiteRow>`
    select seo_settings_json, publisher_identity_json, sitemap_extra_paths_json, robots_txt
    from site where id = ${siteRowId(MAIN_SCOPE)} limit 1
  `
  return rows[0] ?? null
}

/**
 * The SEO columns live on the MAIN-branch site row. Setters are true upserts:
 * on a fresh install (no site row yet) create the shell row first so the
 * subsequent `update` actually lands instead of silently matching 0 rows.
 */
async function ensureSiteRow(db: DbClient): Promise<void> {
  await db`
    insert into site (id, name, branch_id)
    values (${siteRowId(MAIN_SCOPE)}, 'Site', ${MAIN_SCOPE.branchId})
    on conflict (id) do nothing
  `
}

export async function getSiteSeoSettings(db: DbClient): Promise<SeoSettings> {
  const row = await getSiteRow(db)
  if (!row) return parseValue(SeoSettingsSchema, {})
  const raw = readJsonSafe<Partial<SeoSettings>>(row.seo_settings_json, {})
  return { ...parseValue(SeoSettingsSchema, {}), ...raw }
}

export async function setSiteSeoSettings(db: DbClient, patch: Partial<SeoSettings>): Promise<SeoSettings> {
  const current = await getSiteSeoSettings(db)
  const merged: SeoSettings = { ...current, ...patch }
  const json = JSON.stringify(merged)
  await ensureSiteRow(db)
  await db`update site set seo_settings_json = ${json}, updated_at = ${nowIso()}`
  return merged
}

export async function getPublisherIdentity(db: DbClient): Promise<PublisherIdentity> {
  const row = await getSiteRow(db)
  if (!row) return parseValue(PublisherIdentitySchema, {})
  const raw = readJsonSafe<Partial<PublisherIdentity>>(row.publisher_identity_json, {})
  return { ...parseValue(PublisherIdentitySchema, {}), ...raw }
}

export async function setPublisherIdentity(
  db: DbClient,
  patch: Partial<PublisherIdentity>,
): Promise<PublisherIdentity> {
  const current = await getPublisherIdentity(db)
  const merged: PublisherIdentity = { ...current, ...patch }
  const json = JSON.stringify(merged)
  await ensureSiteRow(db)
  await db`update site set publisher_identity_json = ${json}, updated_at = ${nowIso()}`
  return merged
}

export async function getRobotsTxt(db: DbClient): Promise<string> {
  const row = await getSiteRow(db)
  return row?.robots_txt ?? ''
}

export async function setRobotsTxt(db: DbClient, body: string): Promise<string> {
  await ensureSiteRow(db)
  await db`update site set robots_txt = ${body}, updated_at = ${nowIso()}`
  return body
}

// ---------------------------------------------------------------------------
// Redirects
// ---------------------------------------------------------------------------

function normalizeFromPath(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) throw new Error('Redirect from-path is required')
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  // Reject obviously-dangerous inputs early so we never write them.
  if (withSlash.includes('\n') || withSlash.includes('\r')) {
    throw new Error('Redirect from-path must not contain newlines')
  }
  return withSlash
}

function normalizeTargetPath(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) throw new Error('Redirect target-path is required')
  if (trimmed.startsWith('/') || /^https?:\/\//i.test(trimmed)) return trimmed
  return `/${trimmed}`
}

export interface CreateSiteRedirectInput {
  fromPath: string
  targetPath: string
  statusCode?: RedirectStatusCode
  isRegex?: boolean
  enabled?: boolean
  source?: 'manual' | 'csv' | 'import'
  note?: string
}

export interface UpdateSiteRedirectInput {
  id: string
  fromPath?: string
  targetPath?: string
  statusCode?: RedirectStatusCode
  isRegex?: boolean
  enabled?: boolean
  note?: string
}

export async function listSiteRedirects(db: DbClient): Promise<SiteRedirectRow[]> {
  const { rows } = await db<SiteRedirectDbRow>`
    select id, from_path, target_path, status_code, is_regex, enabled,
           source, note, hit_count, last_hit_at, created_at, updated_at
    from site_redirects
    order by enabled desc, from_path asc
  `
  return rows.map(rowToSiteRedirect)
}

export async function listEnabledSiteRedirects(db: DbClient): Promise<SiteRedirectRow[]> {
  const { rows } = await db<SiteRedirectDbRow>`
    select id, from_path, target_path, status_code, is_regex, enabled,
           source, note, hit_count, last_hit_at, created_at, updated_at
    from site_redirects
    where enabled = 1
    order by hit_count desc, from_path asc
  `
  return rows.map(rowToSiteRedirect)
}

export async function getSiteRedirectByPath(
  db: DbClient,
  fromPath: string,
): Promise<SiteRedirectRow | null> {
  const normalized = normalizeFromPath(fromPath)
  const { rows } = await db<SiteRedirectDbRow>`
    select id, from_path, target_path, status_code, is_regex, enabled,
           source, note, hit_count, last_hit_at, created_at, updated_at
    from site_redirects
    where from_path = ${normalized}
    limit 1
  `
  return rows[0] ? rowToSiteRedirect(rows[0]) : null
}

export async function createSiteRedirect(
  db: DbClient,
  input: CreateSiteRedirectInput,
): Promise<SiteRedirectRow> {
  const from = normalizeFromPath(input.fromPath)
  const target = normalizeTargetPath(input.targetPath)
  const status = input.statusCode ?? 301
  if (!RedirectStatusCodes.includes(status)) {
    throw new Error(`Redirect status must be one of ${RedirectStatusCodes.join(', ')}`)
  }
  const id = nanoid()
  await db`
    insert into site_redirects (
      id, from_path, target_path, status_code, is_regex, enabled, source, note
    ) values (
      ${id}, ${from}, ${target}, ${status},
      ${input.isRegex ? 1 : 0}, ${input.enabled === false ? 0 : 1},
      ${input.source ?? 'manual'}, ${input.note ?? ''}
    )
    on conflict (from_path) where enabled = 1 do update
      set target_path = excluded.target_path,
          status_code = excluded.status_code,
          is_regex = excluded.is_regex,
          enabled = excluded.enabled,
          source = excluded.source,
          note = excluded.note,
          updated_at = ${nowIso()}
  `
  const created = await getSiteRedirectByPath(db, from)
  if (!created) throw new Error('site_redirect insert succeeded but row missing on re-read')
  return created
}

export async function updateSiteRedirect(
  db: DbClient,
  input: UpdateSiteRedirectInput,
): Promise<SiteRedirectRow | null> {
  const fields: string[] = []
  const values: Array<string | number | null> = []

  if (input.fromPath !== undefined) {
    fields.push('from_path = ?')
    values.push(normalizeFromPath(input.fromPath))
  }
  if (input.targetPath !== undefined) {
    fields.push('target_path = ?')
    values.push(normalizeTargetPath(input.targetPath))
  }
  if (input.statusCode !== undefined) {
    if (!RedirectStatusCodes.includes(input.statusCode)) {
      throw new Error(`Redirect status must be one of ${RedirectStatusCodes.join(', ')}`)
    }
    fields.push('status_code = ?')
    values.push(input.statusCode)
  }
  if (input.isRegex !== undefined) {
    fields.push('is_regex = ?')
    values.push(input.isRegex ? 1 : 0)
  }
  if (input.enabled !== undefined) {
    fields.push('enabled = ?')
    values.push(input.enabled ? 1 : 0)
  }
  if (input.note !== undefined) {
    fields.push('note = ?')
    values.push(input.note)
  }
  if (fields.length === 0) return getSiteRedirectById(db, input.id)

  fields.push('updated_at = ?')
  values.push(nowIso())
  values.push(input.id)

  // Build dynamic update — repos stay parameterised, the only string concat
  // is the column list (driven by enum branches above, never by user input).
  const sql = `update site_redirects set ${fields.join(', ')} where id = ?`
  await db.unsafe(sql, values)
  return getSiteRedirectById(db, input.id)
}

export async function getSiteRedirectById(
  db: DbClient,
  id: string,
): Promise<SiteRedirectRow | null> {
  const { rows } = await db<SiteRedirectDbRow>`
    select id, from_path, target_path, status_code, is_regex, enabled,
           source, note, hit_count, last_hit_at, created_at, updated_at
    from site_redirects
    where id = ${id}
    limit 1
  `
  return rows[0] ? rowToSiteRedirect(rows[0]) : null
}

export async function deleteSiteRedirect(db: DbClient, id: string): Promise<void> {
  await db`delete from site_redirects where id = ${id}`
}

export async function deleteAllSiteRedirects(db: DbClient): Promise<number> {
  const result = await db`delete from site_redirects`
  // bun:sqlite returns { changes: number } in unsafe-result rows; pg returns
  // { rowCount: number }. Tolerate both.
  const changes =
    typeof result === 'object' && result !== null
      ? Number((result as { changes?: number; rowCount?: number }).changes ??
          (result as { rowCount?: number }).rowCount ?? 0)
      : 0
  return changes
}

export async function bulkInsertSiteRedirects(
  db: DbClient,
  rows: CreateSiteRedirectInput[],
  options: { replace?: boolean } = {},
): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0
  let skipped = 0
  await db.transaction(async (tx) => {
    if (options.replace) {
      await tx`delete from site_redirects`
    }
    for (const row of rows) {
      try {
        const from = normalizeFromPath(row.fromPath)
        const target = normalizeTargetPath(row.targetPath)
        const status = row.statusCode ?? 301
        if (!RedirectStatusCodes.includes(status)) {
          skipped += 1
          continue
        }
        await tx`
          insert into site_redirects (
            id, from_path, target_path, status_code, is_regex, enabled, source, note
          ) values (
            ${nanoid()}, ${from}, ${target}, ${status},
            ${row.isRegex ? 1 : 0}, ${row.enabled === false ? 0 : 1},
            ${row.source ?? 'csv'}, ${row.note ?? ''}
          )
        `
        inserted += 1
      } catch {
        skipped += 1
      }
    }
  })
  return { inserted, skipped }
}

export async function recordSiteRedirectHit(db: DbClient, fromPath: string): Promise<void> {
  const normalized = normalizeFromPath(fromPath)
  await db`
    update site_redirects
    set hit_count = hit_count + 1,
        last_hit_at = ${nowIso()},
        updated_at = updated_at
    where from_path = ${normalized} and enabled = 1
  `
}

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

export { parseRedirectsCsv }

export interface CsvImportResult {
  inserted: number
  skipped: number
  errors: Array<{ line: number; reason: string; row: Record<string, string> }>
}

export async function importRedirectsCsv(
  db: DbClient,
  csv: string,
  options: { replace?: boolean } = {},
): Promise<CsvImportResult> {
  const parsed = parseRedirectsCsv(csv)
  const result: CsvImportResult = { inserted: 0, skipped: 0, errors: [] }
  const inserts: CreateSiteRedirectInput[] = []

  for (const item of parsed.rows) {
    if (!item.from || !item.target) {
      result.errors.push({ line: item.line, reason: 'Missing from or target', row: item.raw })
      result.skipped += 1
      continue
    }
    const status = parseStatusCode(item.status)
    if (status === null) {
      result.errors.push({ line: item.line, reason: 'Invalid status code', row: item.raw })
      result.skipped += 1
      continue
    }
    inserts.push({
      fromPath: item.from,
      targetPath: item.target,
      statusCode: status,
      isRegex: item.regex === 'true' || item.regex === '1',
      enabled: item.enabled !== 'false',
      source: 'csv',
      note: item.note ?? '',
    })
  }

  const bulk = await bulkInsertSiteRedirects(db, inserts, options)
  result.inserted = bulk.inserted
  result.skipped += bulk.skipped
  return result
}

function parseStatusCode(raw: string | undefined): RedirectStatusCode | null {
  if (!raw) return 301
  const n = Number.parseInt(raw, 10)
  if (RedirectStatusCodes.includes(n as RedirectStatusCode)) return n as RedirectStatusCode
  return null
}

export async function exportRedirectsCsv(db: DbClient): Promise<string> {
  const redirects = await listSiteRedirects(db)
  const lines: string[] = ['from,target,status,regex,enabled,source,note,hit_count,last_hit_at']
  for (const row of redirects) {
    const cells = [
      csvEscape(row.fromPath),
      csvEscape(row.targetPath),
      String(row.statusCode),
      row.isRegex ? 'true' : 'false',
      row.enabled ? 'true' : 'false',
      csvEscape(row.source),
      csvEscape(row.note),
      String(row.hitCount),
      csvEscape(row.lastHitAt ?? ''),
    ]
    lines.push(cells.join(','))
  }
  return lines.join('\n') + '\n'
}

function csvEscape(value: string): string {
  if (value === '') return ''
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}
