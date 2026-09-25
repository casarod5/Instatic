/**
 * Phase 3b seed — WebCanvas AI lanes (GRAAAAA-98).
 *
 * Wires Instatic's AI settings (plan decision D6: our lanes only, never a
 * third-party key):
 *
 *   DEFAULT  lane  — freellmapi pool gateway, OpenAI-style wire protocol.
 *                    Driven by the existing `openai-compatible` driver in
 *                    `baseUrl` auth mode (custom base URL IS supported — this
 *                    resolves plan open question D6-1 with evidence).
 *   FALLBACK lane  — LexiLava local Ollama over the tailnet (gpt-oss:20b).
 *                    Driven by the `ollama` driver in `baseUrl` auth mode.
 *
 * Both lanes are seeded as provider credentials for the installation owner,
 * and every tool scope default (site/content/data/plugin) is pointed at the
 * default lane. The fallback needs NO code change to engage — the operator
 * flips the scope default's credentialId (settings UI or this script with
 * AI_LANE_PRIMARY=ollama), which is exactly the Phase-3 acceptance shape.
 *
 * GUARD (no third-party keys in config): the only providers this script can
 * write are `openai-compatible` and `ollama`; the only key it can store is
 * read from the operator's own environment. Enforced at authoring time by
 * `src/__tests__/architecture/ai-lane-config-guard.test.ts`.
 *
 * Usage (idempotent — safe to re-run):
 *   bun scripts/seed-ai-lanes.ts
 *
 * Env:
 *   SEED_DATABASE_URL   sqlite:./.tmp/dev.db            (same as starter seed)
 *   FREELLM_BASE_URL    http://127.0.0.1:3001/v1        (local pool gateway;
 *                       inside a container use http://host.docker.internal:3001/v1)
 *   FREELLM_API_KEY     <operator env only — NEVER hardcode/commit>
 *   FREELLM_MODEL_ID    auto:reason
 *   OLLAMA_BASE_URL     http://100.64.171.54:11434      (LexiLava tailnet)
 *   OLLAMA_MODEL_ID     gpt-oss:20b
 *   AI_LANE_PRIMARY     freellmapi | ollama             (which lane owns the
 *                       scope defaults after seeding; default freellmapi)
 */
import { createDbClient } from '../server/db/index.ts'
import { runMigrations } from '../server/db/runMigrations.ts'
import {
  createCredentialForUser,
  listCredentialsForUser,
  updateCredentialForUser,
} from '../server/ai/credentials/store.ts'
import { setDefaultForScope } from '../server/ai/defaults/store.ts'
import type { ToolScope } from '../server/ai/runtime/types.ts'

// ---------------------------------------------------------------------------
// Guard constants — the surface the architecture test scans. Editing these
// requires editing the test, which is the point.
// ---------------------------------------------------------------------------

/** The ONLY provider ids this seed may write. Hosted third-party providers
 *  are rejected below, before any DB write. */
const ALLOWED_PROVIDER_IDS = ['openai-compatible', 'ollama'] as const

const FREELLM = {
  providerId: 'openai-compatible' as const,
  label: 'webcanvas: freellmapi pool (default lane)',
  baseUrl: process.env.FREELLM_BASE_URL ?? 'http://127.0.0.1:3001/v1',
  // Key comes from the operator environment only. The store encrypts it at
  // rest; absent key = ambient/credentialexternal handling by the driver.
  apiKey: process.env.FREELLM_API_KEY || undefined,
  modelId: process.env.FREELLM_MODEL_ID ?? 'auto:reason',
}

const OLLAMA = {
  providerId: 'ollama' as const,
  label: 'webcanvas: LexiLava Ollama (fallback lane)',
  baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://100.64.171.54:11434',
  apiKey: undefined, // tailnet-scoped local Ollama: no key by design
  modelId: process.env.OLLAMA_MODEL_ID ?? 'gpt-oss:20b',
}

const ALL_SCOPES: ToolScope[] = ['site', 'content', 'data', 'plugin']

function assertLaneGuard() {
  for (const lane of [FREELLM, OLLAMA]) {
    if (!(ALLOWED_PROVIDER_IDS as readonly string[]).includes(lane.providerId)) {
      throw new Error(
        `[seed-ai-lanes] REFUSED: provider "${lane.providerId}" is not an ` +
          `allowed lane (${ALLOWED_PROVIDER_IDS.join(', ')}). ` +
          `Plan D6: no third-party providers in WebCanvas config.`,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

const databaseUrl = process.env.SEED_DATABASE_URL ?? 'sqlite:./.tmp/dev.db'
const { db, migrations } = createDbClient(databaseUrl)
await runMigrations(db, migrations)

// Resolve the installation owner — provider credentials are per-user.
const { rows: ownerRows } = await db<{ id: string }>`
  select u.id
  from users u
  join roles r on r.id = u.role_id
  where r.slug = 'owner'
  order by u.created_at
  limit 1
`
const ownerId = ownerRows[0]?.id
if (!ownerId) {
  throw new Error(
    '[seed-ai-lanes] no owner user found. Boot the app once (or run the dev flow) ' +
      'to create the owner account, then re-run this seed.',
  )
}

assertLaneGuard()

async function upsertLane(lane: typeof FREELLM | typeof OLLAMA): Promise<string> {
  const existing = (await listCredentialsForUser(db, ownerId)).find(
    (c) => c.providerId === lane.providerId && c.displayLabel === lane.label,
  )
  if (existing) {
    await updateCredentialForUser(db, ownerId, existing.id, {
      baseUrl: lane.baseUrl,
      ...(lane.apiKey ? { apiKey: lane.apiKey } : {}),
    })
    console.log(`[seed-ai-lanes] updated  ${lane.providerId}  ${lane.baseUrl}`)
    return existing.id
  }
  const created = await createCredentialForUser(db, ownerId, {
    providerId: lane.providerId,
    authMode: 'baseUrl',
    displayLabel: lane.label,
    baseUrl: lane.baseUrl,
    ...(lane.apiKey ? { apiKey: lane.apiKey } : {}),
  })
  console.log(`[seed-ai-lanes] created  ${lane.providerId}  ${lane.baseUrl}`)
  return created.id
}

const freellmCredId = await upsertLane(FREELLM)
const ollamaCredId = await upsertLane(OLLAMA)

const primary =
  process.env.AI_LANE_PRIMARY === 'ollama'
    ? { id: ollamaCredId, modelId: OLLAMA.modelId, name: 'ollama' }
    : { id: freellmCredId, modelId: FREELLM.modelId, name: 'freellmapi' }

for (const scope of ALL_SCOPES) {
  await setDefaultForScope(db, scope, primary.id, primary.modelId, ownerId)
  console.log(`[seed-ai-lanes] default[${scope}] -> ${primary.name} (${primary.modelId})`)
}

console.log(
  `[seed-ai-lanes] done. Fallback lane present as credential "${OLLAMA.label}"; ` +
    `engage with AI_LANE_PRIMARY=ollama re-run or the providers UI. No third-party keys written.`,
)
