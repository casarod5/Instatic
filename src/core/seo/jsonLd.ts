/**
 * JSON-LD emitters (Phase 1.5, GRAAAAA-69, plan D7).
 *
 * Pure functions — input data, output a `<script type="application/ld+json">`
 * string ready to splice into the page. Validation lives in the TypeBox
 * schemas in `./types.ts`; these emitters are the production path.
 *
 * The D7 set:
 *   - LocalBusiness w/ NAP (emitted as the site default on every page,
 *     overridden per-page by per-city LocalBusiness for City Landing pages).
 *   - Service (emitted when the page is a Service Page template instance).
 *   - FAQ (emitted when the page carries `faq` cells).
 *   - BreadcrumbList (emitted when the template+entry carry a breadcrumb
 *     stack — typically homepage > service > city or homepage > blog post).
 */

import type {
  BreadcrumbItem,
  BreadcrumbPayload,
  FaqItem,
  FaqPayload,
  LocalBusinessPayload,
  PublisherIdentity,
  ServicePayload,
} from './types'

/**
 * Wrap a JSON-LD payload in the `<script type="application/ld+json">` tag
 * the page ships to the browser. We escape `</script>` so an editor can't
 * inject a closing tag through any field.
 */
export function renderJsonLdScript(payload: unknown): string {
  const json = JSON.stringify(payload).replace(/<\/script/gi, '<\\/script')
  return `<script type="application/ld+json">${json}</script>`
}

/**
 * Emit a LocalBusiness payload from the site's `publisher_identity_json`
 * record, plus per-page overrides. The City Landing template reuses this
 * helper but supplies a per-city NAP.
 */
export function buildLocalBusinessJsonLd(
  identity: Partial<PublisherIdentity>,
  overrides: {
    name?: string
    telephone?: string
    address?: PublisherIdentity['address']
    areaServed?: string
    url?: string
    image?: string
  } = {},
): LocalBusinessPayload {
  const payload: LocalBusinessPayload = {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name: overrides.name ?? identity.name ?? '',
    ...(identity.legalName ? { legalName: identity.legalName } : {}),
    ...(identity.url ?? overrides.url ? { url: overrides.url ?? identity.url } : {}),
    ...(identity.logo ? { logo: identity.logo } : {}),
    ...(identity.image ?? overrides.image ? { image: overrides.image ?? identity.image } : {}),
    ...(identity.telephone ?? overrides.telephone
      ? { telephone: overrides.telephone ?? identity.telephone }
      : {}),
    ...(identity.email ? { email: identity.email } : {}),
    ...(identity.priceRange ? { priceRange: identity.priceRange } : {}),
    ...(overrides.address ?? identity.address
      ? { address: overrides.address ?? identity.address }
      : {}),
    ...(identity.geo ? { geo: identity.geo } : {}),
    ...(identity.openingHours ? { openingHours: identity.openingHours } : {}),
    ...(identity.sameAs ? { sameAs: identity.sameAs } : {}),
    ...(overrides.areaServed ? { areaServed: overrides.areaServed } : {}),
  }
  // Preserve any custom fields the admin added (aggregateRating, etc.).
  for (const [key, value] of Object.entries(identity)) {
    if (!(key in payload)) {
      ;(payload as Record<string, unknown>)[key] = value
    }
  }
  return payload
}

/**
 * Service JSON-LD. `provider` defaults to a LocalBusiness built from the
 * site identity so a Service page that doesn't override it still ties back
 * to a verifiable business entity.
 */
export function buildServiceJsonLd(input: {
  name: string
  description?: string
  serviceType?: string
  url?: string
  image?: string
  areaServed?: string | string[]
  provider?: PublisherIdentity
}): ServicePayload {
  const provider = input.provider
  return {
    '@context': 'https://schema.org',
    '@type': 'Service',
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
    ...(input.serviceType ? { serviceType: input.serviceType } : {}),
    ...(input.url ? { url: input.url } : {}),
    ...(input.image ? { image: input.image } : {}),
    ...(input.areaServed ? { areaServed: input.areaServed } : {}),
    ...(provider
      ? { provider: buildLocalBusinessJsonLd(provider) }
      : {}),
  }
}

/**
 * FAQ JSON-LD. Items with empty questions or answers are dropped — a
 * half-filled FAQ editor should never emit empty Question rows.
 */
export function buildFaqJsonLd(items: FaqItem[]): FaqPayload {
  const cleaned = items
    .map((item) => ({
      question: (item.question ?? '').trim(),
      answer: (item.answer ?? '').trim(),
    }))
    .filter((item) => item.question && item.answer)
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: cleaned.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: { '@type': 'Answer', text: item.answer },
    })),
  }
}

/**
 * BreadcrumbList JSON-LD. Always includes the homepage at position 1.
 * Items beyond that come from the supplied stack; items without a URL are
 * skipped (a crumb that doesn't link is a UX dead-end, not breadcrumb
 * metadata).
 */
export function buildBreadcrumbJsonLd(
  siteUrl: string,
  stack: BreadcrumbItem[],
): BreadcrumbPayload | null {
  const homeUrl = siteUrl.replace(/\/$/, '')
  const items: BreadcrumbItem[] = [{ name: 'Home', url: `${homeUrl}/` }, ...stack]
  const valid = items.filter((item) => item.name && item.url)
  if (valid.length === 0) return null
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: valid.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: item.url,
    })),
  }
}
