/**
 * GRAAAAA-65 — the module lead form must not drop the ZIP the live
 * granitecrm.com funnel collects (required, ZIP or ZIP+4). The field is
 * the service-area qualifier for lead follow-up, so a silent drop loses
 * territory data on every new lead.
 */
import { describe, expect, test } from 'bun:test'
import { mapFormToWebcanvasLead, type LeadForwardConfig } from '../leadForward'

const config: LeadForwardConfig = {
  url: 'http://127.0.0.1:3011/api/webcanvas/forms',
  secret: 'shh',
  site: 'granitebros.com',
  formUrl: 'granitecrm.com',
  timeoutMs: 5000,
}

describe('mapFormToWebcanvasLead — zip forwarding (GRAAAAA-65)', () => {
  test('forwards a 5-digit zip', () => {
    const payload = mapFormToWebcanvasLead(
      { name: 'Jane Smith', email: 'jane@example.com', zip: '01609' },
      config,
    )
    expect(payload).not.toBeNull()
    expect((payload?.fields as Record<string, unknown>).zip).toBe('01609')
  })

  test('forwards a ZIP+4 verbatim', () => {
    const payload = mapFormToWebcanvasLead(
      { name: 'Jane Smith', email: 'jane@example.com', zip: '01609-1234' },
      config,
    )
    expect((payload?.fields as Record<string, unknown>).zip).toBe('01609-1234')
  })

  test('trims surrounding whitespace', () => {
    const payload = mapFormToWebcanvasLead(
      { name: 'Jane Smith', email: 'jane@example.com', zip: ' 01609 ' },
      config,
    )
    expect((payload?.fields as Record<string, unknown>).zip).toBe('01609')
  })

  test('omits zip entirely when the form did not collect one', () => {
    const payload = mapFormToWebcanvasLead(
      { name: 'Jane Smith', email: 'jane@example.com' },
      config,
    )
    expect(payload).not.toBeNull()
    expect((payload?.fields as Record<string, unknown>)).not.toHaveProperty('zip')
  })

  test('reads zip from the nested values envelope the runtime posts', () => {
    const payload = mapFormToWebcanvasLead(
      { values: { name: 'Jane Smith', phone: '5550101234', zip: '01609' } },
      config,
    )
    expect((payload?.fields as Record<string, unknown>).zip).toBe('01609')
  })

  test('zip alone never satisfies the contact-identity gate', () => {
    const payload = mapFormToWebcanvasLead({ name: 'Jane Smith', zip: '01609' }, config)
    expect(payload).toBeNull()
  })
})