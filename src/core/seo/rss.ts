/**
 * RSS 2.0 generator (Phase 1.5, GRAAAAA-69 / GRAAAAA-87, plan D7).
 *
 * `buildRssFeed` emits a valid RSS 2.0 feed for the Blog Post template —
 * one `<item>` per published row in the `posts` system post type, sorted
 * newest-first, capped at the configured `maxItems` (default 50).
 *
 * Required channel fields: title, link, description. Optional: language,
 * lastBuildDate (always set), atom:link rel=self (so validators can
 * confirm the canonical feed URL).
 *
 * Each item includes:
 *   - title, link (absolute canonical), description
 *   - pubDate (RFC-822)
 *   - guid with isPermaLink="true" (canonical URL)
 *   - author + category (when present)
 */

export interface RssItem {
  title: string
  link: string
  description: string
  /** ISO 8601 publication timestamp. */
  pubDate?: string
  /** Author display name; falls back to channel author. */
  author?: string
  /** Optional categories — each becomes a <category> element. */
  categories?: string[]
  /** Optional GUID — defaults to the link. */
  guid?: string
}

export interface RssFeedInput {
  siteTitle: string
  siteUrl: string
  feedUrl: string
  description: string
  language?: string
  author?: string
  items: RssItem[]
  /** Cap number of items; default 50. */
  maxItems?: number
}

export function buildRssFeed(input: RssFeedInput): string {
  const siteUrl = input.siteUrl.replace(/\/+$/, '')
  const items = input.items.slice(0, input.maxItems ?? 50)
  const lastBuildDate = new Date().toUTCString()
  const language = input.language ?? 'en-US'

  const xmlItems = items.map((item) => formatItem(item, siteUrl)).join('\n')
  const escapedTitle = escapeXml(input.siteTitle)
  const escapedDescription = escapeXml(input.description)
  const escapedFeedUrl = escapeXml(input.feedUrl)
  const escapedSiteUrl = escapeXml(siteUrl)

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel>
  <title>${escapedTitle}</title>
  <link>${escapedSiteUrl}</link>
  <atom:link href="${escapedFeedUrl}" rel="self" type="application/rss+xml" />
  <description>${escapedDescription}</description>
  <language>${escapeXml(language)}</language>
  <lastBuildDate>${lastBuildDate}</lastBuildDate>${input.author ? `\n  <managingEditor>${escapeXml(input.author)}</managingEditor>` : ''}
${xmlItems}
</channel>
</rss>`
}

function formatItem(item: RssItem, siteUrl: string): string {
  const link = item.link.startsWith('http') ? item.link : `${siteUrl}${item.link}`
  const guid = item.guid ?? link
  const pubDate = item.pubDate ? new Date(item.pubDate).toUTCString() : new Date().toUTCString()
  const categories = (item.categories ?? [])
    .filter(Boolean)
    .map((category) => `    <category>${escapeXml(category)}</category>`)
    .join('\n')
  return [
    '  <item>',
    `    <title>${escapeXml(item.title)}</title>`,
    `    <link>${escapeXml(link)}</link>`,
    `    <guid isPermaLink="true">${escapeXml(guid)}</guid>`,
    `    <pubDate>${pubDate}</pubDate>`,
    item.author ? `    <author>${escapeXml(item.author)}</author>` : '',
    `    <description>${escapeXml(item.description)}</description>`,
    categories,
    '  </item>',
  ]
    .filter(Boolean)
    .join('\n')
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
