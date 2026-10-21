/**
 * GRAAAAA-65 blocker 4b — the published form runtime must reach the CRM bridge.
 *
 * Regression test for the cutover blocker where every real lead died on the
 * local `leads` table: the CRM forward lived on POST /api/forms/submit, an
 * endpoint no published page ever called, while the shipped runtime posts to
 * POST /_instatic/form/submit. These tests pin the forward to the path real
 * visitors actually hit, and pin the dead twin endpoint as gone.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import type { DbResult } from '../../../server/db'
import { handlePublicFormRequest } from '../../../server/forms/handler'
import { handleServerRequest } from '../../../server/router'
import { resetPublicFormChallenges, issuePublicFormPageToken } from '../../../server/forms/challenge'
import { publicFormPerFormRateLimit, publicFormPerIpRateLimit } from '../../../server/forms/rateLimit'
import { resetPublicOrigins } from '../../../server/auth/security'
import { hookBus } from '@core/plugins/hookBus'
import { createFakeDb } from './dbTestFake'
import type { PublishedPageSnapshot } from '../../../server/repositories/publish'

interface CapturedRequest {
  url: string
  body: Record<string, unknown>
  secret: string | null
}

const captured: CapturedRequest[] = []

const BRIDGE_URL = 'http://crm.test:3011/api/webcanvas/forms'

/** Stand-in for the granitecrm-platform lead bridge. Records what it receives. */
const originalFetch = globalThis.fetch

function installFetch(status = 200, response: Record<string, unknown> = { leadId: 'lead_1' }) {
  captured.length = 0
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    captured.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      secret: headers.get('x-webcanvas-secret'),
    })
    return new Response(JSON.stringify(response), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
}

function node(id: string, moduleId: string, props: Record<string, unknown>, children: string[] = []) {
  return { id, moduleId, props, children, breakpointOverrides: {}, classIds: [] }
}

/** A leads table with the contact identity the CRM bridge requires. */
function makeSnapshot(): PublishedPageSnapshot {
  return {
    cmsSnapshotVersion: 1,
    pageRowId: 'page-home',
    site: {
      id: 'site',
      name: 'Site',
      settings: {},
      pages: [{
        id: 'page-home',
        slug: 'index',
        title: 'Home',
        rootNodeId: 'body',
        nodes: {
          body: node('body', 'base.body', {}, ['form']),
          form: node('form', 'base.form', {
            mode: 'cms',
            formId: 'estimate',
            targetTableId: 'leads',
            honeypotName: 'website',
            minSubmitSeconds: 0,
          }, ['name', 'email', 'phone', 'message', 'honeypot']),
          name: node('name', 'base.input', { fieldId: 'name', name: 'name', id: 'name-input', inputType: 'text', required: true }),
          email: node('email', 'base.input', { fieldId: 'email', name: 'email', id: 'email-input', inputType: 'email', required: true }),
          phone: node('phone', 'base.input', { fieldId: 'phone', name: 'phone', id: 'phone-input', inputType: 'tel', required: false }),
          message: node('message', 'base.input', { fieldId: 'message', name: 'message', id: 'message-input', inputType: 'textarea', required: false }),
          honeypot: node('honeypot', 'base.input', { fieldId: 'website', name: 'website', id: 'website-input', inputType: 'text', required: false }),
        },
      }],
      visualComponents: [],
      classes: [],
      breakpoints: [],
      settingsVersion: 1,
    },
  } as PublishedPageSnapshot
}

interface FakeTableRow {
  id: string
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

const leadsTableRow: FakeTableRow = {
  id: 'leads',
  logical_id: 'leads',
  name: 'Leads',
  slug: 'leads',
  kind: 'data',
  route_base: '',
  singular_label: 'Lead',
  plural_label: 'Leads',
  primary_field_id: 'name',
  fields_json: [
    { id: 'name', label: 'Name', type: 'text', required: true },
    { id: 'email', label: 'Email', type: 'email', required: true },
    { id: 'phone', label: 'Phone', type: 'text', required: false },
    { id: 'message', label: 'Message', type: 'text', required: false },
    { id: 'website', label: 'Website', type: 'text', required: false },
  ],
  system: 0,
}

function makeDb() {
  const createdRows: Record<string, unknown>[] = []
  const snapshot = makeSnapshot()
  const tableRows: Record<string, FakeTableRow> = { leads: leadsTableRow }
  const db = createFakeDb(async (rawSql, params): Promise<DbResult> => {
    const sql = rawSql.replace(/\s+/g, ' ').trim().toLowerCase()
    if (sql.includes('site_snapshots.site_json')) {
      return {
        rows: [{
          row_id: snapshot.pageRowId,
          site_json: snapshot.site,
          runtime_assets_json: snapshot.runtimeAssets ?? null,
          importmap_body: null,
          importmap_sha256: null,
        }],
        rowCount: 1,
      }
    }
    if (sql.startsWith('select logical_id, name, slug, kind, route_base')) {
      const row = tableRows[String(params[0])]
      if (!row) return { rows: [], rowCount: 0 }
      return {
        rows: [{
          ...row,
          created_by_user_id: null,
          updated_by_user_id: null,
          created_at: new Date('2026-06-01T00:00:00Z'),
          updated_at: new Date('2026-06-01T00:00:00Z'),
        }],
        rowCount: 1,
      }
    }
    if (sql.startsWith('insert into data_rows')) {
      createdRows.push({ id: params[0], table_id: params[2], cells_json: params[3], slug: params[4] })
      return { rows: [{ logical_id: params[0] }], rowCount: 1 }
    }
    if (sql.startsWith('select data_tables.slug')) {
      return { rows: [{ slug: 'leads' }], rowCount: 1 }
    }
    if (sql.startsWith('select data_rows.logical_id') && sql.includes('from data_rows')) {
      const row = createdRows.find((candidate) => candidate.id === params[0])
      if (!row) return { rows: [], rowCount: 0 }
      const stamp = new Date('2026-06-01T00:00:00Z')
      return {
        rows: [{
          ...row,
          author_email: null,
          author_display_name: null,
          author_role_slug: null,
          author_role_name: null,
          created_by_email: null,
          created_by_display_name: null,
          created_by_role_slug: null,
          created_by_role_name: null,
          updated_by_email: null,
          updated_by_display_name: null,
          updated_by_role_slug: null,
          updated_by_role_name: null,
          published_by_email: null,
          published_by_display_name: null,
          published_by_role_slug: null,
          published_by_role_name: null,
          created_at: stamp,
          updated_at: stamp,
          published_at: null,
        }],
        rowCount: 1,
      }
    }
    if (sql.startsWith('select count(*)') && sql.includes('data_row_versions')) return { rows: [{ count: 0 }], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  })
  return { db, createdRows }
}

function makeRequest(path: string, body: unknown, origin = 'http://cms.test', ip?: string) {
  const req = new Request(`http://cms.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  req.headers.set('origin', origin)
  req.headers.set('sec-fetch-site', 'same-origin')
  if (ip) {
    const { stampSocketIp } = require('../../../server/auth/security') as typeof import('../../../server/auth/security')
    stampSocketIp(req, ip)
  }
  return req
}

function pageToken(): string {
  return issuePublicFormPageToken({ pageId: 'page-home', formId: 'estimate' })
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>
}

async function submitLead(ip: string, values: Record<string, unknown>) {
  const challengeResponse = await handlePublicFormRequest(
    makeRequest('/_instatic/form/challenge', { formId: 'estimate', pageId: 'page-home', pageToken: pageToken() }, 'http://cms.test', ip),
    makeDb().db,
    new URL('http://cms.test/_instatic/form/challenge'),
  )
  const challenge = await readJson(challengeResponse!)
  const { db, createdRows } = makeDb()
  const submit = await handlePublicFormRequest(
    makeRequest('/_instatic/form/submit', {
      formId: 'estimate',
      pageId: 'page-home',
      token: challenge.token,
      challenge: challenge.challenge,
      values,
    }, 'http://cms.test', ip),
    db,
    new URL('http://cms.test/_instatic/form/submit'),
  )
  return { submit, createdRows }
}

describe('GRAAAAA-65 blocker 4b — public form submissions reach the CRM bridge', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
    resetPublicOrigins()
    resetPublicFormChallenges()
    hookBus.reset()
    delete process.env.LEAD_FORWARD_URL
    delete process.env.LEAD_FORWARD_SECRET
  })

  it('forwards an accepted submission to the CRM bridge from the endpoint the runtime actually calls', async () => {
    process.env.LEAD_FORWARD_URL = BRIDGE_URL
    process.env.LEAD_FORWARD_SECRET = 'test-secret'
    installFetch()

    resetPublicFormChallenges()
    publicFormPerIpRateLimit.reset('203.0.113.7')
    publicFormPerFormRateLimit.reset('203.0.113.7|estimate')
    const { submit, createdRows } = await submitLead('203.0.113.7', {
      name: 'Dana Reyes',
      email: 'dana@example.com',
      phone: '555-0101',
      message: 'Quartz countertop quote',
      website: '',
    })

    expect(submit?.status).toBe(200)
    const body = await readJson(submit!)
    expect(body.forwarded).toBe(true)
    // The local row is still the record of truth.
    expect(createdRows).toHaveLength(1)

    // ...and the bridge actually received the lead.
    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe(BRIDGE_URL)
    expect(captured[0].secret).toBe('test-secret')
    const fields = captured[0].body.fields as Record<string, string>
    expect(fields.name).toBe('Dana Reyes')
    expect(fields.email).toBe('dana@example.com')
    expect(fields.phone).toBe('555-0101')
    // Honeypot field never crosses to the CRM.
    expect(fields.website).toBeUndefined()
  })

  it('keeps the lead local and does not fail the visitor when the CRM bridge is down', async () => {
    process.env.LEAD_FORWARD_URL = BRIDGE_URL
    process.env.LEAD_FORWARD_SECRET = 'test-secret'
    installFetch(503, { error: 'crm_unavailable' })

    resetPublicFormChallenges()
    publicFormPerIpRateLimit.reset('203.0.113.8')
    publicFormPerFormRateLimit.reset('203.0.113.8|estimate')
    const { submit, createdRows } = await submitLead('203.0.113.8', {
      name: 'Sam Patel',
      email: 'sam@example.com',
      website: '',
    })

    // The visitor still succeeded and the lead is stored locally.
    expect(submit?.status).toBe(200)
    const body = await readJson(submit!)
    expect(body.ok).toBe(true)
    expect(body.forwarded).toBe(false)
    expect(createdRows).toHaveLength(1)
  })

  it('stays inert when the bridge is not configured', async () => {
    installFetch()
    resetPublicFormChallenges()
    publicFormPerIpRateLimit.reset('203.0.113.9')
    publicFormPerFormRateLimit.reset('203.0.113.9|estimate')
    const { submit, createdRows } = await submitLead('203.0.113.9', {
      name: 'Noor Haddad',
      email: 'noor@example.com',
      website: '',
    })

    expect(submit?.status).toBe(200)
    expect(createdRows).toHaveLength(1)
    expect(captured).toHaveLength(0)
  })

  it('the dead unauthenticated twin endpoint no longer exists', async () => {
    // POST /api/forms/submit forwarded straight to the CRM with no origin
    // check, rate limit, or challenge. It was unreachable from published
    // output, so it is deleted rather than left as an injection surface.
    const response = await handleServerRequest(
      new Request('http://cms.test/api/forms/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Mallory', email: 'mallory@example.com' }),
      }),
      { db: makeDb().db },
    )

    expect(response.status).not.toBe(202)
    expect(captured).toHaveLength(0)
  })
})