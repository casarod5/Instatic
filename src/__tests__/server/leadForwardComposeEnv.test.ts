import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

/**
 * GRAAAAA-65 blocker 2: the lead forward is env-gated — `readLeadForwardConfig`
 * (server/forms/leadForward.ts) returns null when LEAD_FORWARD_URL or
 * LEAD_FORWARD_SECRET is unset, and the module is then inert: every public form
 * submission stays local and no lead ever reaches the CRM bridge.
 *
 * Compose only forwards variables that are LISTED in the service `environment`
 * block. Setting LEAD_FORWARD_URL in the host shell or in .env is not enough —
 * if the key is absent from compose.prod.yml it never enters the container, and
 * the documented production deploy path (docs/deployment/vps.md) silently ships a
 * build where the feature can never turn on.
 *
 * These assertions pin the compose surface to the env-gate contract so a future
 * rename or a dropped key fails here instead of in production.
 */
const FORWARD_VARS = [
  'LEAD_FORWARD_URL',
  'LEAD_FORWARD_SECRET',
  'LEAD_FORWARD_SITE',
  'LEAD_FORWARD_FORM_URL',
  'LEAD_FORWARD_TIMEOUT_MS',
] as const

describe('lead forward wiring in the self-host deploy path', () => {
  it('passes every LEAD_FORWARD_* var into the app container', () => {
    const compose = readFileSync('compose.prod.yml', 'utf8')

    for (const name of FORWARD_VARS) {
      expect(compose).toContain(`${name}:`)
    }
  })

  it('reads each forward var from the deploy env, not a hardcoded literal', () => {
    const compose = readFileSync('compose.prod.yml', 'utf8')

    // `${NAME:-}` keeps the file loadable with an empty .env (same contract as
    // INSTATIC_SECRET_KEY — see the Postgres placeholder test above). A hardcoded
    // default would either bake a real bridge URL into the repo or leave the
    // container with a value the operator never chose.
    for (const name of FORWARD_VARS) {
      expect(compose).toMatch(new RegExp(`\\$\\{${name}:-\\}`))
    }
  })

  it('documents the forward vars in the production env template', () => {
    const env = readFileSync('.env.production.example', 'utf8')

    for (const name of FORWARD_VARS) {
      expect(env).toContain(`${name}=`)
    }
  })

  it('keeps the env-gate contract the compose file depends on', () => {
    // The compose wiring is only meaningful while the module stays inert on
    // partial config. If this ever changes to "forward with a default secret",
    // the unset-deploy behaviour above becomes a data-leak bug and this
    // assertion is the tripwire.
    const leadForward = readFileSync('server/forms/leadForward.ts', 'utf8')

    expect(leadForward).toContain('if (!url || !secret) return null')
  })
})