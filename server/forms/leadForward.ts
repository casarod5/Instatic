/**
 * WebCanvas P5 (GRAAAAA-66) — form submission → CRM bridge (instatic side).
 *
 * Forwards public form submissions from POST /api/forms/submit to the
 * granitecrm-platform WebCanvas lead bridge (POST /api/webcanvas/forms,
 * GRAAAAA-94): shared-secret auth, { site, formUrl, fields } payload,
 * same LeadCreateInputSchema contract, single dedupe/write path.
 *
 * Env-gated: when LEAD_FORWARD_URL / LEAD_FORWARD_SECRET are unset this
 * module is inert and the endpoint keeps its upstream accept-and-acknowledge
 * stub behavior, so existing deployments are unchanged.
 *
 * Env:
 * - LEAD_FORWARD_URL       full CRM bridge URL (e.g. http://127.0.0.1:3011/api/webcanvas/forms)
 * - LEAD_FORWARD_SECRET    value for the X-Webcanvas-Secret header
 * - LEAD_FORWARD_SITE      LeadSourceSite value sent as `site` (default "other")
 * - LEAD_FORWARD_FORM_URL  optional explicit formUrl (falls back to request Origin)
 * - LEAD_FORWARD_TIMEOUT_MS forward timeout (default 5000)
 */
import { jsonResponse } from '../http'

export interface LeadForwardConfig {
  url: string
  secret: string
  site: string
  formUrl: string | null
  timeoutMs: number
}

function submissionValues(body: Record<string, unknown>): Record<string, unknown> {
  const values = body.values
  if (values && typeof values === 'object' && !Array.isArray(values)) {
    return values as Record<string, unknown>
  }
  return body
}

function readString(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim() !== '') return v.trim()
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return undefined
}

export function readLeadForwardConfig(req: Request): LeadForwardConfig | null {
  const url = process.env.LEAD_FORWARD_URL
  const secret = process.env.LEAD_FORWARD_SECRET
  if (!url || !secret) return null
  let formUrl = process.env.LEAD_FORWARD_FORM_URL ?? null
  if (!formUrl) {
    const origin = req.headers.get('origin')
    if (origin) {
      try {
        formUrl = new URL(origin).host
      } catch {
        formUrl = null
      }
    }
  }
  return {
    url,
    secret,
    site: process.env.LEAD_FORWARD_SITE ?? 'other',
    formUrl,
    timeoutMs: Number(process.env.LEAD_FORWARD_TIMEOUT_MS ?? 5000) || 5000,
  }
}

const FORWARDABLE_FIELDS = ['name', 'phone', 'email', 'message'] as const
const HONEYPOT_FIELDS = ['website', 'companyWebsite'] as const

/** Honeypot fields filled → silent accept without forwarding (mirrors the CRM bridge). */
export function honeypotFilled(body: Record<string, unknown>): boolean {
  const values = submissionValues(body)
  for (const field of HONEYPOT_FIELDS) {
    const v = values[field]
    if (typeof v === 'string' && v.trim() !== '') return true
  }
  return false
}

/**
 * Map a public form payload onto the WebCanvas bridge contract
 * `{ site, formUrl?, fields }`. `service` selections are appended to the
 * message so they survive the shared LeadCreateInputSchema contract.
 * Returns null when no forwardable contact identity is present
 * (name + phone or email — the CRM requires one dedupe key).
 */
export function mapFormToWebcanvasLead(
  body: Record<string, unknown>,
  config: LeadForwardConfig,
): Record<string, unknown> | null {
  const values = submissionValues(body)
  const fields: Record<string, unknown> = {}
  for (const field of FORWARDABLE_FIELDS) {
    const v = readString(values[field])
    if (v !== undefined) fields[field] = v
  }
  const service = readString(values.service)
  if (service) {
    fields.message = fields.message ? `${fields.message}\nService: ${service}` : `Service: ${service}`
  }
  if (!fields.name || !(fields.phone || fields.email)) return null
  const payload: Record<string, unknown> = { site: config.site, fields }
  if (config.formUrl) payload.formUrl = config.formUrl
  return payload
}

export interface LeadForwardResult {
  forwarded: boolean
  crmStatus: number | null
  leadId?: string
  deduped?: boolean
  assigned?: boolean
  error?: string
}

/** POST the mapped lead to the CRM bridge. Never throws. */
export async function forwardLeadToCrm(
  payload: Record<string, unknown>,
  config: LeadForwardConfig,
): Promise<LeadForwardResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)
  try {
    const res = await fetch(config.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webcanvas-secret': config.secret },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    const data = (await res.json().catch(() => null)) as {
      leadId?: string
      deduped?: boolean
      routing?: { assigned?: boolean }
      error?: string
    } | null
    if (!res.ok) {
      return { forwarded: false, crmStatus: res.status, error: data?.error ?? `crm_status_${res.status}` }
    }
    return {
      forwarded: true,
      crmStatus: res.status,
      leadId: data?.leadId,
      deduped: data?.deduped,
      assigned: data?.routing?.assigned,
    }
  } catch (err) {
    return { forwarded: false, crmStatus: null, error: err instanceof Error ? err.name : 'forward_failed' }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * POST /api/forms/submit handler. Without forward env: the upstream stub
 * (202 {accepted:true}). With forward env: validate, honeypot-drop, forward
 * to the CRM bridge; CRM failures are logged and swallowed behind a 202 so
 * public submitters never see control-plane errors.
 */
export async function handleFormSubmit(req: Request): Promise<Response> {
  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return jsonResponse({ accepted: false, error: 'invalid_json' }, { status: 400 })
  }
  const config = readLeadForwardConfig(req)
  if (!config) return jsonResponse({ accepted: true }, { status: 202 })
  if (honeypotFilled(body)) return jsonResponse({ accepted: true }, { status: 202 })
  const payload = mapFormToWebcanvasLead(body, config)
  if (!payload) {
    return jsonResponse({ accepted: false, error: 'missing_contact_identity' }, { status: 400 })
  }
  const result = await forwardLeadToCrm(payload, config)
  if (!result.forwarded) {
    console.error(`[leadForward] CRM bridge forward failed (status=${result.crmStatus}): ${result.error}`)
    return jsonResponse({ accepted: true, forwarded: false }, { status: 202 })
  }
  return jsonResponse(
    { accepted: true, forwarded: true, deduped: result.deduped ?? false, leadId: result.leadId ?? null },
    { status: 202 },
  )
}
