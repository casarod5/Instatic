/**
 * Architecture Source-Scan — WebCanvas AI lane guard (GRAAAAA-98 / plan D6)
 *
 * The WebCanvas module is wired to OUR lanes only:
 *   - freellmapi pool gateway (openai-compatible driver, custom base URL)
 *   - LexiLava local Ollama over the tailnet (ollama driver)
 *
 * This test guards the *config surface* of that wiring: it scans every file
 * that can carry AI lane configuration (the lane seed script and deploy env
 * material) and fails if:
 *
 *   1. A third-party provider id appears as a seeded credential
 *      (`anthropic`, `openai`, `openrouter`, or any other driver id that
 *      requires an operator account on an external provider).
 *   2. A third-party provider endpoint appears in config
 *      (api.openai.com, api.anthropic.com, openrouter.ai, generativelanguage…).
 *   3. A provider API key is present as a literal — keys must always be read
 *      from `process.env` and supplied by the operator environment
 *      (SOPS/local secrets), never committed.
 *
 * WHY THIS MATTERS
 * ----------------
 * Plan of record `plans/granitecrm-webcanvas-module.md` decision D6: model
 * access goes through the freellmapi pool or the LexiLava local lane. A
 * third-party key in config is a policy violation, a per-token spend leak,
 * and (for the marketing pages this module publishes) a brand-risk. The seed
 * script's ALLOWED_PROVIDER_IDS list is the second line of defence; this
 * scan is independent of it (it checks raw text, not the constant).
 *
 * @see scripts/seed-ai-lanes.ts — the guarded config surface
 */

import { describe, it, expect } from 'bun:test'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

const REPO_ROOT = join(import.meta.dir, '../../../')

/** Files that carry (or document) AI lane configuration. */
const CONFIG_FILES = ['scripts/seed-ai-lanes.ts', 'deploy/kita-starter.env.example', 'deploy/kita-staging.compose.yml']

/** Third-party providers that must never be configured for WebCanvas. */
const BANNED_PROVIDER_IDS = ['anthropic', 'openrouter', "'openai'", '"openai"', 'generativelanguage', 'googleapis']

/** Third-party provider endpoints that must never appear in config. */
const BANNED_HOSTS = [
  'api.openai.com',
  'api.anthropic.com',
  'openrouter.ai',
  'generativelanguage.googleapis.com',
  'api.mistral.ai',
  'api.together.xyz',
  'api.groq.com',
]

/** Patterns that indicate a committed API key literal. */
const KEY_LITERAL_PATTERNS = [
  /\bsk-[A-Za-z0-9_\-]{8,}/, // OpenAI-style
  /\bsk-ant-[A-Za-z0-9_\-]{8,}/, // Anthropic-style
  /\bAIza[0-9A-Za-z_\-]{8,}/, // Google-style
  /apiKey:\s*['"][A-Za-z0-9]/, // apiKey: 'literal…' (must be process.env)
  /api_key\s*=\s*[^\s<][^\s]+/i, // env-file style literal (placeholders like <…> allowed)
]

function readConfig(path: string): { path: string; text: string } | null {
  const full = join(REPO_ROOT, path)
  if (!existsSync(full)) return null
  return { path, text: readFileSync(full, 'utf8') }
}

describe('ai-lane config guard (D6: our lanes only)', () => {
  const files = CONFIG_FILES.map(readConfig).filter((f): f is NonNullable<typeof f> => f !== null)

  it('lane config surface exists', () => {
    expect(files.some((f) => f.path === 'scripts/seed-ai-lanes.ts')).toBe(true)
  })

  it('no third-party provider ids in seeded AI config', () => {
    for (const f of files) {
      for (const id of BANNED_PROVIDER_IDS) {
        expect(f.text, `${f.path} must not reference third-party provider ${id}`).not.toContain(id)
      }
    }
  })

  it('no third-party provider endpoints in seeded AI config', () => {
    for (const f of files) {
      for (const host of BANNED_HOSTS) {
        expect(f.text, `${f.path} must not contain third-party endpoint ${host}`).not.toContain(host)
      }
    }
  })

  it('no API key literals in config (keys come from process.env only)', () => {
    for (const f of files) {
      for (const pattern of KEY_LITERAL_PATTERNS) {
        expect(f.text, `${f.path} contains a key literal matching ${pattern}`).not.toMatch(pattern)
      }
    }
  })

  it('seed script restricts itself to the two approved lane providers', () => {
    const seed = readConfig('scripts/seed-ai-lanes.ts')
    expect(seed).not.toBeNull()
    // The allowlist constant is the runtime guard — it must contain exactly
    // the two lane providers and nothing else.
    const m = seed!.text.match(/ALLOWED_PROVIDER_IDS\s*=\s*\[([^\]]*)\]/)
    expect(m, 'ALLOWED_PROVIDER_IDS constant not found in seed script').not.toBeNull()
    const ids = m![1]!.match(/'[^']+'/g) ?? []
    expect(ids.sort()).toEqual(["'ollama'", "'openai-compatible'"])
  })
})
