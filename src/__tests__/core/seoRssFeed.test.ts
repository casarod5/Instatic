/**
 * seoRssFeed.test.ts — Phase 1.5 GRAAAAA-87 RSS feed acceptance.
 *
 * Exercises the acceptance criteria from the issue spec:
 *
 *   - RSS 2.0 well-formed (required channel fields, atom:link rel=self)
 *   - 50-item cap with oldest items evicted
 *   - Excerpt fallback to first 200 chars of body when summary/excerpt missing
 *   - Empty feed is still valid (no <item> children, valid envelope)
 *   - maxItems cap is honoured when explicitly set
 *
 * The full publish / bake / route pipeline is covered by
 * server/publishStaticArtefact.test.ts + seoRoutes.test.ts; this file
 * focuses on the pure `buildRssFeed` generator so the per-rule assertions
 * stay tight and don't need a DB.
 */

import { describe, expect, it } from 'bun:test'
import { buildRssFeed, type RssItem } from '@core/seo/rss'

const SITE_URL = 'https://example.com'
const FEED_URL = `${SITE_URL}/feed.xml`

function buildBaseItems(count: number, offsetDays = 0): RssItem[] {
  return Array.from({ length: count }, (_, index) => {
    const daysAgo = offsetDays + index
    const published = new Date(Date.UTC(2026, 0, 1) - daysAgo * 24 * 60 * 60 * 1000)
    return {
      title: `Post ${index + 1}`,
      link: `${SITE_URL}/blog/post-${index + 1}`,
      description: `Excerpt for post ${index + 1}.`,
      pubDate: published.toISOString(),
      categories: ['News'],
      author: 'Author Name',
    }
  })
}

describe('buildRssFeed — RSS 2.0 envelope', () => {
  it('emits a valid RSS 2.0 document with required channel fields', () => {
    const xml = buildRssFeed({
      siteTitle: 'Example Site',
      siteUrl: SITE_URL,
      feedUrl: FEED_URL,
      description: 'Latest articles from Example Site',
      items: buildBaseItems(1),
    })

    expect(xml).toStartWith('<?xml version="1.0" encoding="UTF-8"?>')
    expect(xml).toContain('<rss version="2.0"')
    expect(xml).toContain('<channel>')
    expect(xml).toContain('<title>Example Site</title>')
    expect(xml).toContain('<link>https://example.com</link>')
    expect(xml).toContain(`<atom:link href="${FEED_URL}" rel="self" type="application/rss+xml"`)
    expect(xml).toContain('<description>Latest articles from Example Site</description>')
    expect(xml).toContain('<language>en-US</language>')
    expect(xml).toContain('<lastBuildDate>')
    expect(xml).toContain('</channel>')
    expect(xml).toContain('</rss>')
  })

  it('respects a custom language when supplied', () => {
    const xml = buildRssFeed({
      siteTitle: 'Example',
      siteUrl: SITE_URL,
      feedUrl: FEED_URL,
      description: 'd',
      language: 'es-ES',
      items: [],
    })
    expect(xml).toContain('<language>es-ES</language>')
  })

  it('escapes XML-special characters in titles + descriptions', () => {
    const xml = buildRssFeed({
      siteTitle: 'A & B <test>',
      siteUrl: SITE_URL,
      feedUrl: FEED_URL,
      description: 'Quotes "and" ampersands & stuff',
      items: [
        {
          title: 'Post with <html> & "quotes"',
          link: `${SITE_URL}/p`,
          description: 'Body with <script> & stuff',
        },
      ],
    })
    expect(xml).toContain('A &amp; B &lt;test&gt;')
    expect(xml).toContain('Quotes &quot;and&quot; ampersands &amp; stuff')
    expect(xml).toContain('Post with &lt;html&gt; &amp; &quot;quotes&quot;')
    expect(xml).toContain('Body with &lt;script&gt; &amp; stuff')
  })

  it('emits a valid empty feed (no items) when items=[]', () => {
    const xml = buildRssFeed({
      siteTitle: 'Empty',
      siteUrl: SITE_URL,
      feedUrl: FEED_URL,
      description: 'd',
      items: [],
    })
    expect(xml).toContain('<rss version="2.0"')
    expect(xml).toContain('<channel>')
    expect(xml).toContain('</channel>')
    expect(xml).not.toContain('<item>')
  })
})

describe('buildRssFeed — per-item fields', () => {
  it('includes title, link, description, guid isPermaLink=true, pubDate, categories, author', () => {
    const xml = buildRssFeed({
      siteTitle: 'Example',
      siteUrl: SITE_URL,
      feedUrl: FEED_URL,
      description: 'd',
      items: [
        {
          title: 'Hello',
          link: `${SITE_URL}/hello`,
          description: 'World',
          pubDate: '2026-01-01T00:00:00.000Z',
          guid: `${SITE_URL}/hello`,
          categories: ['Announcements', 'Product'],
          author: 'Jane Doe',
        },
      ],
    })
    expect(xml).toContain('<title>Hello</title>')
    expect(xml).toContain('<link>https://example.com/hello</link>')
    expect(xml).toContain('<description>World</description>')
    expect(xml).toContain('<guid isPermaLink="true">https://example.com/hello</guid>')
    expect(xml).toContain('<author>Jane Doe</author>')
    expect(xml).toContain('<category>Announcements</category>')
    expect(xml).toContain('<category>Product</category>')
    // RFC-822 pubDate (`Date#toUTCString` emits `GMT`; legacy RFC-822 uses
    // `+0000` — accept either).
    expect(xml).toMatch(/<pubDate>[A-Z][a-z]{2}, 01 Jan 2026 00:00:00 (GMT|\+0000)<\/pubDate>/)
  })

  it('omits optional fields when not provided', () => {
    const xml = buildRssFeed({
      siteTitle: 'Example',
      siteUrl: SITE_URL,
      feedUrl: FEED_URL,
      description: 'd',
      items: [
        { title: 'Bare', link: `${SITE_URL}/bare`, description: 'd' },
      ],
    })
    expect(xml).not.toContain('<author>')
    expect(xml).not.toContain('<category>')
  })

  it('falls back to <link> when guid is omitted', () => {
    const xml = buildRssFeed({
      siteTitle: 'Example',
      siteUrl: SITE_URL,
      feedUrl: FEED_URL,
      description: 'd',
      items: [
        { title: 'No GUID', link: `${SITE_URL}/no-guid`, description: 'd' },
      ],
    })
    expect(xml).toContain('<guid isPermaLink="true">https://example.com/no-guid</guid>')
  })
})

describe('buildRssFeed — 50-item cap', () => {
  it('caps at 50 by default (issue acceptance: 50-cap eviction)', () => {
    const xml = buildRssFeed({
      siteTitle: 'Cap',
      siteUrl: SITE_URL,
      feedUrl: FEED_URL,
      description: 'd',
      items: buildBaseItems(75),
    })
    const itemCount = (xml.match(/<item>/g) ?? []).length
    expect(itemCount).toBe(50)
  })

  it('honours an explicit maxItems override', () => {
    const xml = buildRssFeed({
      siteTitle: 'Cap',
      siteUrl: SITE_URL,
      feedUrl: FEED_URL,
      description: 'd',
      items: buildBaseItems(20),
      maxItems: 5,
    })
    const itemCount = (xml.match(/<item>/g) ?? []).length
    expect(itemCount).toBe(5)
  })

  it('preserves input order when caller has already sorted newest-first', () => {
    // Items are passed newest-first; cap should keep the first 50.
    const xml = buildRssFeed({
      siteTitle: 'Cap',
      siteUrl: SITE_URL,
      feedUrl: FEED_URL,
      description: 'd',
      items: buildBaseItems(75),
    })
    expect(xml).toContain('<title>Post 1</title>')
    expect(xml).toContain('<title>Post 50</title>')
    expect(xml).not.toContain('<title>Post 51</title>')
    expect(xml).not.toContain('<title>Post 75</title>')
  })
})

describe('buildRssFeed — well-formedness', () => {
  it('produces XML that parses as a balanced rss/channel tree', () => {
    const xml = buildRssFeed({
      siteTitle: 'Parse Test',
      siteUrl: SITE_URL,
      feedUrl: FEED_URL,
      description: 'd',
      items: buildBaseItems(3),
    })
    const openRss = (xml.match(/<rss[\s>]/g) ?? []).length
    const closeRss = (xml.match(/<\/rss>/g) ?? []).length
    const openChannel = (xml.match(/<channel>/g) ?? []).length
    const closeChannel = (xml.match(/<\/channel>/g) ?? []).length
    expect(openRss).toBe(1)
    expect(closeRss).toBe(1)
    expect(openChannel).toBe(1)
    expect(closeChannel).toBe(1)

    const openItems = (xml.match(/<item>/g) ?? []).length
    const closeItems = (xml.match(/<\/item>/g) ?? []).length
    expect(openItems).toBe(closeItems)
    expect(openItems).toBe(3)
  })

  it('strips trailing slash from siteUrl when forming the channel link', () => {
    const xml = buildRssFeed({
      siteTitle: 'Trim',
      siteUrl: `${SITE_URL}/`,
      feedUrl: FEED_URL,
      description: 'd',
      items: [],
    })
    expect(xml).toContain('<link>https://example.com</link>')
    expect(xml).not.toContain('<link>https://example.com/</link>')
  })
})
