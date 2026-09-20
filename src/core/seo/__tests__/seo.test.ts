/**
 * Phase 1.5 (GRAAAAA-69) unit tests for the pure SEO builders in @core/seo:
 * sitemap exactness, robots.txt, RSS 2.0 feed, redirects CSV parsing,
 * JSON-LD payloads, and canonical resolution.
 */
import { describe, expect, it } from 'bun:test'
import { buildSitemapXml, buildRobotsTxt } from '../sitemap'
import { buildRssFeed } from '../rss'
import { parseRedirectsCsv } from '../csv'
import {
  buildBreadcrumbJsonLd,
  buildFaqJsonLd,
  buildLocalBusinessJsonLd,
  renderJsonLdScript,
} from '../jsonLd'
import { resolveCanonicalUrl } from '../canonical'

describe('buildSitemapXml — exactness', () => {
  const siteUrl = 'https://granite.example.com'

  it('emits exactly one <url> per live page, no staging/draft paths', () => {
    const xml = buildSitemapXml({
      siteUrl,
      pages: [
        { path: '/' },
        { path: '/about' },
        { path: '/services/countertops' },
      ],
      publishedAt: '2026-09-20T12:00:00.000Z',
    })
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])
    expect(locs).toEqual([
      'https://granite.example.com/',
      'https://granite.example.com/about',
      'https://granite.example.com/services/countertops',
    ])
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(xml.trim().endsWith('</urlset>')).toBe(true)
  })

  it('excludes noindex and excludeFromSitemap pages', () => {
    const xml = buildSitemapXml({
      siteUrl,
      pages: [
        { path: '/' },
        { path: '/internal-draft', noindex: true },
        { path: '/thank-you', excludeFromSitemap: true },
      ],
    })
    expect(xml).not.toContain('/internal-draft')
    expect(xml).not.toContain('/thank-you')
    expect(xml).toContain('<loc>https://granite.example.com/</loc>')
  })

  it('excludes redirected paths (301 target must not compete in the sitemap)', () => {
    const xml = buildSitemapXml({
      siteUrl,
      pages: [{ path: '/' }, { path: '/old-page' }],
      redirectedPaths: ['/old-page'],
    })
    expect(xml).not.toContain('/old-page')
  })

  it('dedupes identical URLs across pages and extraPaths', () => {
    const xml = buildSitemapXml({
      siteUrl,
      pages: [{ path: '/' }, { path: '/' }],
      extraPaths: ['/'],
    })
    expect([...xml.matchAll(/<loc>/g)]).toHaveLength(1)
  })

  it('escapes XML entities in URLs', () => {
    const xml = buildSitemapXml({
      siteUrl: 'https://granite.example.com',
      pages: [{ path: '/search?q=a&b=c' }],
    })
    expect(xml).toContain('/search?q=a&amp;b=c')
    expect(xml).not.toContain('/search?q=a&b=c</loc>')
  })

  it('returns an empty urlset when siteUrl is missing', () => {
    const xml = buildSitemapXml({ siteUrl: '', pages: [{ path: '/' }] })
    expect(xml).toContain('<urlset')
    expect(xml).not.toContain('<url>')
  })
})

describe('buildRobotsTxt', () => {
  it('default body allows all and references the sitemap', () => {
    const body = buildRobotsTxt({ siteUrl: 'https://granite.example.com/' })
    expect(body).toBe(
      'User-agent: *\nAllow: /\nSitemap: https://granite.example.com/sitemap.xml\n',
    )
  })

  it('custom body is used verbatim', () => {
    const body = buildRobotsTxt({
      siteUrl: 'https://granite.example.com',
      customBody: 'User-agent: GPTBot\nDisallow: /',
    })
    expect(body).toBe('User-agent: GPTBot\nDisallow: /')
  })
})

describe('buildRssFeed — RSS 2.0', () => {
  it('emits channel metadata and per-item fields with isPermaLink guids', () => {
    const xml = buildRssFeed({
      siteTitle: 'Granite Blog',
      siteUrl: 'https://granite.example.com',
      feedUrl: 'https://granite.example.com/feed.xml',
      description: 'Countertop notes',
      items: [
        {
          title: 'First post',
          link: 'https://granite.example.com/blog/first-post',
          description: 'Hello',
          pubDate: '2026-09-20T10:00:00.000Z',
          categories: ['granite'],
        },
      ],
    })
    expect(xml).toContain('<title>Granite Blog</title>')
    expect(xml).toContain('<link>https://granite.example.com</link>')
    expect(xml).toContain('rel="self" type="application/rss+xml"')
    expect(xml).toContain('<title>First post</title>')
    expect(xml).toContain('isPermaLink="true"')
    expect(xml).toContain('<category>granite</category>')
    // RFC-822 pubDate, not raw ISO
    expect(xml).toContain('Sep')
    expect(xml).not.toContain('2026-09-20T10:00:00.000Z</pubDate>')
    expect(xml).toContain('<rss version="2.0"')
  })

  it('caps items at maxItems', () => {
    const xml = buildRssFeed({
      siteTitle: 'T',
      siteUrl: 'https://x.example.com',
      feedUrl: 'https://x.example.com/feed.xml',
      description: 'd',
      maxItems: 2,
      items: [1, 2, 3].map((n) => ({
        title: `p${n}`,
        link: `https://x.example.com/blog/p${n}`,
        description: 'd',
      })),
    })
    expect(xml).toContain('p1')
    expect(xml).toContain('p2')
    expect(xml).not.toContain('p3')
  })
})

describe('parseRedirectsCsv — RFC-4180 subset', () => {
  it('parses the documented header format with defaults', () => {
    const parsed = parseRedirectsCsv(
      'from,target,status,regex,enabled,note\n' +
        '/old,/new,301,false,true,Plain move\n' +
        '/promo,https://example.com/promo,302,false,false,Seasonal',
    )
    expect(parsed.rows).toHaveLength(2)
    expect(parsed.rows[0]).toMatchObject({ from: '/old', target: '/new', status: '301' })
    expect(parsed.rows[1]).toMatchObject({ enabled: 'false', status: '302' })
  })

  it('treats a headerless first line as data', () => {
    const parsed = parseRedirectsCsv('/a,/b')
    expect(parsed.rows).toHaveLength(1)
    expect(parsed.rows[0].from).toBe('/a')
    expect(parsed.rows[0].target).toBe('/b')
  })

  it('supports quoted fields with embedded commas', () => {
    const parsed = parseRedirectsCsv('from,target,note\n/a,/b,"Note, with comma"')
    expect(parsed.rows[0].note).toBe('Note, with comma')
  })
})

describe('JSON-LD builders', () => {
  it('LocalBusiness carries NAP from publisher identity', () => {
    const payload = buildLocalBusinessJsonLd(
      {
        name: 'Granite Works',
        telephone: '+1-508-555-0142',
        address: {
          '@type': 'PostalAddress',
          streetAddress: '12 Main St',
          addressLocality: 'Worcester',
          addressRegion: 'MA',
          postalCode: '01608',
          addressCountry: 'US',
        },
      },
      { areaServed: 'Worcester County' },
    )
    expect(payload['@type']).toBe('LocalBusiness')
    expect(payload.name).toBe('Granite Works')
    expect(payload.telephone).toBe('+1-508-555-0142')
    expect((payload.address as Record<string, unknown>).addressLocality).toBe('Worcester')
    expect(payload.areaServed).toBe('Worcester County')
  })

  it('FAQPage wraps each Q/A as a Question with acceptedAnswer', () => {
    const payload = buildFaqJsonLd([
      { question: 'How long does install take?', answer: 'One day.' },
    ])
    expect(payload['@type']).toBe('FAQPage')
    expect(payload.mainEntity[0].name).toBe('How long does install take?')
    expect(payload.mainEntity[0].acceptedAnswer.text).toBe('One day.')
  })

  it('BreadcrumbList puts Home at position 1 and skips URL-less crumbs', () => {
    const payload = buildBreadcrumbJsonLd('https://granite.example.com', [
      { name: 'Services', url: 'https://granite.example.com/services' },
      { name: 'No URL crumb', url: '' },
    ])
    expect(payload?.itemListElement[0]).toMatchObject({ position: 1, name: 'Home' })
    expect(payload?.itemListElement).toHaveLength(2)
    // Empty site still emits the Home crumb at '/' — never null for that case.
    const empty = buildBreadcrumbJsonLd('', [])
    expect(empty?.itemListElement).toEqual([
      { '@type': 'ListItem', position: 1, name: 'Home', item: '/' },
    ])
  })

  it('renderJsonLdScript escapes closing script tags inside payloads', () => {
    const script = renderJsonLdScript({ name: '</script><script>alert(1)</script>' })
    expect(script).toContain('<script type="application/ld+json">')
    expect(script.toLowerCase().includes('</script><script>alert')).toBe(false)
  })
})

describe('resolveCanonicalUrl', () => {
  const siteUrl = 'https://granite.example.com'

  it('maps index to root and strips leading slashes on pages', () => {
    expect(resolveCanonicalUrl({ siteUrl, slug: 'index' })).toBe(`${siteUrl}/`)
    expect(resolveCanonicalUrl({ siteUrl, slug: '/about' })).toBe(`${siteUrl}/about`)
  })

  it('joins routeBase + slug for content entries', () => {
    expect(
      resolveCanonicalUrl({ siteUrl, slug: 'worcester-ma', routeBase: '/cities', isEntry: true }),
    ).toBe(`${siteUrl}/cities/worcester-ma`)
  })

  it('returns empty string without a siteUrl', () => {
    expect(resolveCanonicalUrl({ siteUrl: '', slug: 'about' })).toBe('')
  })
})
