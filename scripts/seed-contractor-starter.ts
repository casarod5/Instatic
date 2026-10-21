/**
 * Phase 1 seed — contractor-site starter templates (GRAAAAA-62).
 *
 * Creates, idempotently (upserts):
 *   - post-type tables: services, cities, leads (typed field schemas = template params)
 *   - visual components: Header, Footer, Hero, Section, CardGrid, LeadForm,
 *     Testimonial, Features (typed VC params)
 *   - template pages: Site Chrome (everywhere), Service Page (services),
 *     City Landing (cities), Blog Post (posts)
 *   - starter pages: Homepage (/), Contact (/contact), About (/about)
 *   - demo entries: one service + one city, fully filled
 */
import { createDbClient } from '../server/db/index.ts'
import { MAIN_SCOPE } from '../server/branches/scope.ts'
import { createDataRow } from '../server/repositories/data/rows/mutations.ts'
import { persistDataRowPublish } from '../server/repositories/data/publish.ts'
import { nanoid } from 'nanoid'

// SEED_DATABASE_URL: override the target DB (e.g. sqlite:./.tmp/kita-staging.db)
// for a fleet-duplicator clone instead of the local dev DB.
const { db } = createDbClient(process.env.SEED_DATABASE_URL ?? 'sqlite:./.tmp/dev.db')

// ---------------------------------------------------------------- helpers --
type Node = { id: string; moduleId: string; props: Record<string, unknown>; breakpointOverrides: Record<string, Record<string, unknown>>; children: string[] }
const nodes: Record<string, Node> = {}
function n(id: string, moduleId: string, props: Record<string, unknown> = {}, children: string[] = [], breakpointOverrides: Record<string, Record<string, unknown>> = {}): string {
  nodes[id] = { id, moduleId, props, breakpointOverrides, children }
  return id
}
const txt = (id: string, text: string, tag = 'p', extra: Record<string, unknown> = {}) => n(id, 'base.text', { text, tag, ...extra })
const ctn = (id: string, children: string[], extra: Record<string, unknown> = {}, breakpointOverrides: Record<string, Record<string, unknown>> = {}) => n(id, 'base.container', { ...extra }, children, breakpointOverrides)
const btn = (id: string, label: string, href: string) => n(id, 'base.button', { label, href })
const lnk = (id: string, text: string, href: string) => n(id, 'base.link', { text, href })
const img = (id: string, src: string, alt: string) => n(id, 'base.image', { src, alt })
function tree(rootId: string) { return { nodes: structuredClone(nodes), rootNodeId: rootId } }
function resetNodes() { for (const k of Object.keys(nodes)) delete nodes[k] }

// Brand design tokens — override via SEED_BRAND_* env to clone the starter
// for another contractor brand (fleet duplicator, GRAAAAA-66).
const BRAND = {
  primary: process.env.SEED_BRAND_PRIMARY ?? '#c2410c', primaryDark: process.env.SEED_BRAND_PRIMARY_DARK ?? '#7c2d12', ink: process.env.SEED_BRAND_INK ?? '#1c1917', muted: process.env.SEED_BRAND_MUTED ?? '#57534e',
  surface: process.env.SEED_BRAND_SURFACE ?? '#fafaf9', accent: process.env.SEED_BRAND_ACCENT ?? '#f59e0b', light: process.env.SEED_BRAND_LIGHT ?? '#fff7ed',
  fontHeading: process.env.SEED_BRAND_FONT_HEADING ?? 'Georgia, serif', fontBody: process.env.SEED_BRAND_FONT_BODY ?? 'system-ui, sans-serif',
}

function tokensNode(): string {
  return txt('brand-tokens', '', 'none', {
    customCss: `:root{--brand-primary:${BRAND.primary};--brand-primary-dark:${BRAND.primaryDark};--brand-ink:${BRAND.ink};--brand-muted:${BRAND.muted};--brand-surface:${BRAND.surface};--brand-accent:${BRAND.accent};--brand-light:${BRAND.light};--brand-font-heading:${BRAND.fontHeading};--brand-font-body:${BRAND.fontBody}}`,
  })
}

// ----------------------------------------------------------- VC factories --
function headerCells(componentIds: Record<string, string>) {
  resetNodes()
  const root = ctn('header-root', [tokensNode(), 'bar'])
  const bar = ctn('bar', ['logo', 'nav-toggle', 'nav', 'cta'])
  txt('logo', 'Granite Brothers', 'span', { className: 'logo' })
  btn('nav-toggle', '≡', '#', { className: 'nav-toggle', 'aria-label': 'Toggle navigation', 'aria-expanded': 'false', 'aria-controls': 'nav' })
  const nav = ctn('nav', ['n1', 'n2', 'n3', 'n4', 'n5'], { className: 'nav-collapse' })
  lnk('n1', 'Home', '/'); lnk('n2', 'Services', '/services'); lnk('n3', 'Service Areas', '/areas')
  lnk('n4', 'About', '/about'); lnk('n5', 'Contact', '/contact')
  btn('cta', 'Get a Free Quote', '/contact')
  return {
    name: 'Header', slug: 'header',
    body: { nodes, rootNodeId: root },
    params: [
      { id: nanoid(), name: 'logoText', type: 'string', defaultValue: 'Granite Brothers', required: true, description: 'Company name shown in the header' },
      { id: nanoid(), name: 'phone', type: 'string', defaultValue: '(555) 123-4567', required: false, description: 'Click-to-call phone number' },
      { id: nanoid(), name: 'primaryColor', type: 'color', defaultValue: BRAND.primary, required: false, description: 'Brand primary (buttons/links)' },
      { id: nanoid(), name: 'sticky', type: 'boolean', defaultValue: true, required: false, description: 'Stick header to viewport top' },
    ],
    classIds: [],
  }
}

function footerCells(componentIds: Record<string, string>) {
  resetNodes()
  const root = ctn('footer-root', ['cols', 'legal'])
  const cols = ctn('cols', ['brand', 'links', 'contact'])
  txt('brand-h', 'Granite Brothers', 'strong')
  txt('brand-p', 'Family-owned granite & kitchen remodeling since 1998.', 'p')
  txt('links-h', 'Explore', 'strong')
  ctn('links', [lnk('l1', 'Services', '/services'), lnk('l2', 'Service Areas', '/areas'), lnk('l3', 'Blog', '/blog')])
  txt('contact-h', 'Contact', 'strong')
  ctn('contact', [txt('c1', '(555) 123-4567', 'p'), txt('c2', 'info@example.com', 'p'), txt('c3', '123 Main St, Worcester, MA', 'p')])
  txt('legal', '© 2026 Granite Brothers. Licensed & insured. MA HIC #123456.', 'small')
  return {
    name: 'Footer', slug: 'footer',
    body: { nodes, rootNodeId: root },
    params: [
      { id: nanoid(), name: 'companyName', type: 'string', defaultValue: 'Granite Brothers', required: true },
      { id: nanoid(), name: 'licenseLine', type: 'string', defaultValue: 'Licensed & insured. MA HIC #123456.', required: false },
      { id: nanoid(), name: 'phone', type: 'string', defaultValue: '(555) 123-4567', required: false },
      { id: nanoid(), name: 'email', type: 'url', defaultValue: 'mailto:info@example.com', required: false },
      { id: nanoid(), name: 'backgroundColor', type: 'color', defaultValue: BRAND.ink, required: false },
    ],
    classIds: [],
  }
}

function heroCells(componentIds: Record<string, string>) {
  resetNodes()
  const root = ctn('hero-root', ['badge', 'title', 'sub', 'cta1', 'cta2'])
  txt('badge', 'Licensed • Insured • Local', 'span')
  txt('title', 'Expert [service] in [city], MA', 'h1')
  txt('sub', 'Free estimates, lifetime workmanship warranty, and crews that show up on time.', 'p')
  btn('cta1', 'Get My Free Estimate', '/contact')
  lnk('cta2', 'See our work →', '/services')
  return {
    name: 'Hero', slug: 'hero',
    body: { nodes, rootNodeId: root },
    params: [
      { id: nanoid(), name: 'badgeText', type: 'string', defaultValue: 'Licensed • Insured • Local', required: false },
      { id: nanoid(), name: 'title', type: 'richText', defaultValue: 'Expert [service] in [city], MA', required: true, description: 'Supports [service]/[city] tokens on template pages' },
      { id: nanoid(), name: 'subtitle', type: 'string', defaultValue: 'Free estimates, lifetime workmanship warranty.', required: false },
      { id: nanoid(), name: 'ctaText', type: 'string', defaultValue: 'Get My Free Estimate', required: false },
      { id: nanoid(), name: 'ctaLink', type: 'url', defaultValue: '/contact', required: false },
      { id: nanoid(), name: 'backgroundImage', type: 'image', defaultValue: null, required: false },
      { id: nanoid(), name: 'overlayOpacity', type: 'number', defaultValue: 0.45, required: false },
      { id: nanoid(), name: 'primaryColor', type: 'color', defaultValue: BRAND.primary, required: false },
    ],
    classIds: [],
  }
}

function sectionCells(componentIds: Record<string, string>) {
  resetNodes()
  const root = ctn('section-root', ['badge', 'title', 'sub', 'content'])
  txt('badge', 'Section label', 'span')
  txt('title', 'Section heading', 'h2')
  txt('sub', 'Supporting line for the section.', 'p')
  n('content', 'base.slot-outlet', { name: 'content' })
  return {
    name: 'Section', slug: 'section',
    body: { nodes, rootNodeId: root },
    params: [
      { id: nanoid(), name: 'badgeText', type: 'string', defaultValue: '', required: false },
      { id: nanoid(), name: 'title', type: 'string', defaultValue: 'Section heading', required: false },
      { id: nanoid(), name: 'subtitle', type: 'string', defaultValue: '', required: false },
      { id: nanoid(), name: 'backgroundColor', type: 'color', defaultValue: BRAND.surface, required: false },
      { id: nanoid(), name: 'paddingY', type: 'number', defaultValue: 64, required: false },
      { id: nanoid(), name: 'content', type: 'slot', defaultValue: null, required: false, description: 'Nested content rendered inside the section' },
    ],
    classIds: [],
    defaultBreakpointOverrides: {
      mobile: { paddingY: 32 }
    },
  }
}

function cardGridCells(componentIds: Record<string, string>) {
  resetNodes()
  const root = ctn('grid-root', ['title', 'grid'])
  txt('title', 'Our Services', 'h2')
  const grid = ctn('grid', ['c1', 'c2', 'c3'], {}, { mobile: { style: 'grid-template-columns: 1fr' } })
  const card = (pre: string, title: string, desc: string) => {
    const cardRoot = ctn(pre, [pre + '-img', pre + '-t', pre + '-d', pre + '-l'])
    img(pre + '-img', '/uploads/' + pre + '.jpg', title)
    txt(pre + '-t', title, 'h3'); txt(pre + '-d', desc, 'p')
    lnk(pre + '-l', 'Learn more →', '/services')
    return cardRoot
  }
  card('c1', 'Kitchen Remodeling', 'Full kitchen design and build — cabinets, countertops, flooring.')
  card('c2', 'Granite Countertops', 'Template, fabrication, and install in as little as one week.')
  card('c3', 'Home Additions', 'Sunrooms, decks, and additions permitted and built to code.')
  return {
    name: 'Card Grid', slug: 'card-grid',
    body: { nodes, rootNodeId: root },
    params: [
      { id: nanoid(), name: 'title', type: 'string', defaultValue: 'Our Services', required: false },
      { id: nanoid(), name: 'columns', type: 'number', defaultValue: 3, required: false },
      { id: nanoid(), name: 'card1Title', type: 'string', defaultValue: 'Kitchen Remodeling', required: false },
      { id: nanoid(), name: 'card1Desc', type: 'string', defaultValue: '', required: false },
      { id: nanoid(), name: 'card1Image', type: 'image', defaultValue: null, required: false },
      { id: nanoid(), name: 'card1Link', type: 'url', defaultValue: '/services', required: false },
      { id: nanoid(), name: 'card2Title', type: 'string', defaultValue: 'Granite Countertops', required: false },
      { id: nanoid(), name: 'card2Desc', type: 'string', defaultValue: '', required: false },
      { id: nanoid(), name: 'card2Image', type: 'image', defaultValue: null, required: false },
      { id: nanoid(), name: 'card2Link', type: 'url', defaultValue: '/services', required: false },
      { id: nanoid(), name: 'card3Title', type: 'string', defaultValue: 'Home Additions', required: false },
      { id: nanoid(), name: 'card3Desc', type: 'string', defaultValue: '', required: false },
      { id: nanoid(), name: 'card3Image', type: 'image', defaultValue: null, required: false },
      { id: nanoid(), name: 'card3Link', type: 'url', defaultValue: '/services', required: false },
    ],
    classIds: [],
    defaultBreakpointOverrides: {
      mobile: { style: 'grid-template-columns: 1fr' }
    },
  }
}

function leadFormCells(componentIds: Record<string, string>) {
  resetNodes()
  const root = ctn('lf-root', ['title', 'sub', 'form'])
  txt('title', 'Get Your Free Estimate', 'h2')
  txt('sub', "Tell us about your project — we respond within one business day.", 'p')
  const form = n('form', 'base.form', {
    mode: 'cms', formId: 'lead-form', targetTableId: 'leads',
    successBehavior: 'message', successMessage: 'Thanks! We will be in touch shortly.',
    honeypotName: 'website', minSubmitSeconds: 3,
  }, ['f-name', 'f-email', 'f-phone', 'f-service', 'f-message', 'f-consent', 'f-website', 'f-submit'])
  
  n('f-name', 'base.input', { fieldId: 'name', name: 'name', inputType: 'text', placeholder: 'Jane Smith', required: true })
  n('f-email', 'base.input', { fieldId: 'email', name: 'email', inputType: 'email', placeholder: 'jane@example.com', required: true })
  n('f-phone', 'base.input', { fieldId: 'phone', name: 'phone', inputType: 'tel', placeholder: '(555) 010-1234', required: false })
  n('f-service', 'base.select', { fieldId: 'service', name: 'service', required: true }, [
    n('f-svc-opt1', 'base.option', { value: 'Kitchen Remodeling', label: 'Kitchen Remodeling' }),
    n('f-svc-opt2', 'base.option', { value: 'Granite Countertops', label: 'Granite Countertops' }),
    n('f-svc-opt3', 'base.option', { value: 'Home Addition', label: 'Home Addition' }),
    n('f-svc-opt4', 'base.option', { value: 'Other', label: 'Other' }),
  ])
  n('f-message', 'base.textarea', { fieldId: 'message', name: 'message', placeholder: 'Tell us about your project...', required: false })
  n('f-consent', 'base.checkbox', { fieldId: 'consent', name: 'consent', label: 'I agree to be contacted about my project', required: true })
  n('f-website', 'base.input', { fieldId: 'website', name: 'website', inputType: 'text', required: false }) // honeypot
  n('f-submit', 'base.submit', { label: 'Send My Request', formId: 'lead-form' })
  
  return {
    name: 'Lead Form', slug: 'lead-form',
    body: { nodes, rootNodeId: root },
    params: [
      { id: nanoid(), name: 'title', type: 'string', defaultValue: 'Get Your Free Estimate', required: false },
      { id: nanoid(), name: 'subtitle', type: 'string', defaultValue: 'Tell us about your project — we respond within one business day.', required: false },
      { id: nanoid(), name: 'submitText', type: 'string', defaultValue: 'Send My Request', required: false },
      { id: nanoid(), name: 'serviceOptions', type: 'string', defaultValue: 'Kitchen Remodeling,Granite Countertops,Home Addition,Other', required: false, description: 'Comma-separated dropdown options' },
      { id: nanoid(), name: 'showPhone', type: 'boolean', defaultValue: true, required: false },
    ],
    classIds: [],
  }
}

function testimonialCells(componentIds: Record<string, string>) {
  resetNodes()
  const root = ctn('t-root', ['quote', 'author', 'role'])
  txt('quote', '“They replaced our counters in four days and the fit is perfect. Crew was courteous and cleaned up daily.”', 'p')
  txt('author', '— Sarah M., Worcester', 'strong')
  txt('role', 'Granite Countertop project', 'small')
  return {
    name: 'Testimonial', slug: 'testimonial',
    body: { nodes, rootNodeId: root },
    params: [
      { id: nanoid(), name: 'quote', type: 'richText', defaultValue: '', required: true },
      { id: nanoid(), name: 'author', type: 'string', defaultValue: '', required: false },
      { id: nanoid(), name: 'role', type: 'string', defaultValue: '', required: false },
      { id: nanoid(), name: 'backgroundColor', type: 'color', defaultValue: BRAND.light, required: false },
    ],
    classIds: [],
  }
}

function featuresCells(componentIds: Record<string, string>) {
  resetNodes()
  const root = ctn('feat-root', ['title', 'grid'])
  txt('title', 'Why Homeowners Choose Us', 'h2')
  const grid = ctn('grid', ['f1', 'f2', 'f3', 'f4'])
  const feature = (pre: string, icon: string, title: string, desc: string) => {
    const r = ctn(pre, [pre + '-i', pre + '-t', pre + '-d'])
    txt(pre + '-i', icon, 'span'); txt(pre + '-t', title, 'h3'); txt(pre + '-d', desc, 'p')
    return r
  }
  feature('f1', '🛡️', 'Licensed & Insured', 'Full MA HIC licensing and liability coverage on every job.')
  feature('f2', '⭐', '5-Star Rated', 'Hundreds of verified reviews across Greater Worcester.')
  feature('f3', '🏆', 'Lifetime Warranty', 'Workmanship guaranteed for as long as you own your home.')
  feature('f4', '⚡', 'On-Time, On-Budget', 'Written schedule and fixed price before we start.')
  return {
    name: 'Features', slug: 'features',
    body: { nodes, rootNodeId: root },
    params: [
      { id: nanoid(), name: 'title', type: 'string', defaultValue: 'Why Homeowners Choose Us', required: false },
      { id: nanoid(), name: 'item1Icon', type: 'image', defaultValue: null, required: false },
      { id: nanoid(), name: 'item1Title', type: 'string', defaultValue: 'Licensed & Insured', required: false },
      { id: nanoid(), name: 'item1Desc', type: 'string', defaultValue: '', required: false },
      { id: nanoid(), name: 'item2Title', type: 'string', defaultValue: '5-Star Rated', required: false },
      { id: nanoid(), name: 'item2Desc', type: 'string', defaultValue: '', required: false },
      { id: nanoid(), name: 'item3Title', type: 'string', defaultValue: 'Lifetime Warranty', required: false },
      { id: nanoid(), name: 'item3Desc', type: 'string', defaultValue: '', required: false },
      { id: nanoid(), name: 'item4Title', type: 'string', defaultValue: 'On-Time, On-Budget', required: false },
      { id: nanoid(), name: 'item4Desc', type: 'string', defaultValue: '', required: false },
    ],
    classIds: [],
  }
}

// ---------------------------------------------------------------- runner --
async function seedTable(id: string, name: string, singular: string, fields: unknown[], primaryField: string) {
  const fieldsJson = JSON.stringify(fields)
  // Upsert (not skip-if-exists): a re-run must REPAIR drifted rows so
  // idempotency means "converges to spec", not "first write wins".
  // NOTE: SQLite '+' is numeric addition — string concat is '||'.
  await db`
    insert into data_tables (id, name, slug, kind, route_base, singular_label, plural_label, primary_field_id, fields_json, system, branch_id)
    values (${id}, ${name}, ${id}, 'postType', '/' || ${id}, ${singular}, ${name}, ${primaryField}, ${fieldsJson}, 0, 'main')
    on conflict (id) do update set
      name = excluded.name,
      kind = excluded.kind,
      route_base = excluded.route_base,
      singular_label = excluded.singular_label,
      plural_label = excluded.plural_label,
      primary_field_id = excluded.primary_field_id,
      fields_json = excluded.fields_json,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `
  console.log(`+ table ${id} (route /${id}, ${fields.length} fields)`)
}

async function upsertRow(tableId: string, slug: string, cells: Record<string, unknown>, label: string) {
  // Check if row exists
  const existing = await db`select logical_id, status from data_rows where table_id = ${tableId} and slug = ${slug} and branch_id = 'main' and deleted_at is null`
  let rowId: string
  if (existing.rows.length > 0) {
    rowId = existing.rows[0].logical_id as string
    // Update cells_json
    await db`update data_rows set cells_json = ${JSON.stringify(cells)}, updated_at = datetime('now') where logical_id = ${rowId}`
    console.log(`~ updated ${label} → ${rowId}`)
  } else {
    const row = await createDataRow(db, MAIN_SCOPE, { tableId, slug, cells: JSON.stringify(cells) }, null, null, { collabInternal: true })
    rowId = row.id
    console.log(`+ created ${label} → ${rowId}`)
  }
  // Publish (creates new version, sets published status)
  await persistDataRowPublish(db, rowId, null)
  console.log(`  ✓ published ${label}`)
  return rowId
}

console.log('== GRAAAAA-62 Phase 1 seed (corrected) ==')

// 1. Typed param tables (fields = the template's typed parameters)
await seedTable('services', 'Services', 'Service', [
  { type: 'text', id: 'title', label: 'Service Name', required: true },
  { type: 'longText', id: 'heroHeadline', label: 'Hero Headline' },
  { type: 'longText', id: 'heroSubtext', label: 'Hero Subtext' },
  { type: 'image', id: 'heroImage', label: 'Hero Image' },
  { type: 'richText', id: 'body', label: 'Service Description' },
  { type: 'longText', id: 'faqs', label: 'FAQs (one per line: Q | A)' },
  { type: 'text', id: 'seoTitle', label: 'SEO Title' },
  { type: 'longText', id: 'seoDescription', label: 'SEO Description' },
], 'title')

await seedTable('cities', 'Service Areas', 'Service Area', [
  { type: 'text', id: 'title', label: 'City/Town Name', required: true },
  { type: 'text', id: 'state', label: 'State', required: true },
  { type: 'longText', id: 'heroHeadline', label: 'Hero Headline' },
  { type: 'image', id: 'heroImage', label: 'Hero Image' },
  { type: 'richText', id: 'body', label: 'Local Content' },
  { type: 'longText', id: 'neighborhoods', label: 'Neighborhoods (one per line)' },
  { type: 'text', id: 'phone', label: 'Local Phone' },
  { type: 'text', id: 'seoTitle', label: 'SEO Title' },
  { type: 'longText', id: 'seoDescription', label: 'SEO Description' },
], 'title')

// Posts table for blog entries
await seedTable('posts', 'Posts', 'Post', [
  { type: 'text', id: 'title', label: 'Post Title', required: true },
  { type: 'text', id: 'slug', label: 'Slug', required: true },
  { type: 'richText', id: 'body', label: 'Post Content' },
  { type: 'image', id: 'featuredImage', label: 'Featured Image' },
  { type: 'text', id: 'excerpt', label: 'Excerpt' },
  { type: 'text', id: 'author', label: 'Author' },
  { type: 'text', id: 'publishedAt', label: 'Published At' },
  { type: 'text', id: 'seoTitle', label: 'SEO Title' },
  { type: 'longText', id: 'seoDescription', label: 'SEO Description' },
], 'title')

// Leads table for form submissions
await seedTable('leads', 'Leads', 'Lead', [
  { type: 'text', id: 'name', label: 'Full Name', required: true },
  { type: 'text', id: 'email', label: 'Email', required: true },
  { type: 'text', id: 'phone', label: 'Phone' },
  { type: 'text', id: 'service', label: 'Service Needed' },
  { type: 'longText', id: 'message', label: 'Project Details' },
  { type: 'boolean', id: 'consent', label: 'Consent', required: true },
  { type: 'text', id: 'pageUrl', label: 'Page URL' },
  { type: 'text', id: 'utmSource', label: 'UTM Source' },
  { type: 'text', id: 'utmMedium', label: 'UTM Medium' },
  { type: 'text', id: 'utmCampaign', label: 'UTM Campaign' },
  { type: 'text', id: 'status', label: 'Status', required: false },
  { type: 'text', id: 'submittedAt', label: 'Submitted At' },
], 'name')

// 2. Visual components (upsert + publish)
const componentFactories = [
  headerCells, footerCells, heroCells, sectionCells, cardGridCells,
  leadFormCells, testimonialCells, featuresCells,
]

const componentIds: Record<string, string> = {}
for (const factory of componentFactories) {
  const c = factory(componentIds)
  const id = await upsertRow('components', c.slug, c, `component ${c.name}`)
  componentIds[c.slug] = id
  console.log(`  mapped ${c.slug} → ${id}`)
}

// 3. Template pages (componentId refs to VC row ids)
// Chrome (everywhere): header + outlet + footer
resetNodes()
const chromeRoot = ctn('chrome-root', ['hdr', 'outlet', 'ftr'])
n('hdr', 'base.visual-component-ref', { componentId: componentIds['header'], propOverrides: {} })
n('outlet', 'base.outlet', {})
n('ftr', 'base.visual-component-ref', { componentId: componentIds['footer'], propOverrides: {} })
await upsertRow('pages', 'tpl-chrome', {
  title: 'Template — Site Chrome', slug: 'tpl-chrome',
  body: { nodes, rootNodeId: chromeRoot },
  templateEnabled: true, templateTarget: { kind: 'everywhere' }, templatePriority: 100,
}, 'template Site Chrome')

resetNodes()
const svcRoot = ctn('svc-root', ['hero-ref', 'sec1', 'form-ref'])
n('hero-ref', 'base.visual-component-ref', { componentId: componentIds['hero'], propOverrides: {} })
const sec1 = n('sec1', 'base.visual-component-ref', { componentId: componentIds['section'], propOverrides: {} })
n('form-ref', 'base.visual-component-ref', { componentId: componentIds['lead-form'], propOverrides: {} })
await upsertRow('pages', 'tpl-service', {
  title: 'Template — Service Page', slug: 'tpl-service',
  body: { nodes, rootNodeId: svcRoot },
  seoTitle: '[service] in Massachusetts | Granite Brothers',
  templateEnabled: true, templateTarget: { kind: 'postTypes', tableSlugs: ['services'] }, templatePriority: 10,
}, 'template Service Page')

resetNodes()
const cityRoot = ctn('city-root', ['hero-ref', 'features-ref', 'form-ref'])
n('hero-ref', 'base.visual-component-ref', { componentId: componentIds['hero'], propOverrides: {} })
n('features-ref', 'base.visual-component-ref', { componentId: componentIds['features'], propOverrides: {} })
n('form-ref', 'base.visual-component-ref', { componentId: componentIds['lead-form'], propOverrides: {} })
await upsertRow('pages', 'tpl-city', {
  title: 'Template — City Landing', slug: 'tpl-city',
  body: { nodes, rootNodeId: cityRoot },
  templateEnabled: true, templateTarget: { kind: 'postTypes', tableSlugs: ['cities'] }, templatePriority: 10,
}, 'template City Landing')

resetNodes()
const postRoot = ctn('post-root', ['article', 'form-ref'])
n('article', 'base.slot-outlet', { name: 'post-body' })
n('form-ref', 'base.visual-component-ref', { componentId: componentIds['lead-form'], propOverrides: {} })
await upsertRow('pages', 'tpl-blog-post', {
  title: 'Template — Blog Post', slug: 'tpl-blog-post',
  body: { nodes, rootNodeId: postRoot },
  templateEnabled: true, templateTarget: { kind: 'postTypes', tableSlugs: ['posts'] }, templatePriority: 10,
}, 'template Blog Post')

// 4. Starter pages
resetNodes()
const homeRoot = ctn('home-root', ['hero-ref', 'grid-ref', 'features-ref', 't-ref', 'form-ref'])
n('hero-ref', 'base.visual-component-ref', { componentId: componentIds['hero'], propOverrides: {} })
n('grid-ref', 'base.visual-component-ref', { componentId: componentIds['card-grid'], propOverrides: {} })
n('features-ref', 'base.visual-component-ref', { componentId: componentIds['features'], propOverrides: {} })
n('t-ref', 'base.visual-component-ref', { componentId: componentIds['testimonial'], propOverrides: {} })
n('form-ref', 'base.visual-component-ref', { componentId: componentIds['lead-form'], propOverrides: {} })
await upsertRow('pages', 'home', {
  title: 'Granite Brothers — Kitchen & Bath Remodeling in Worcester, MA', slug: 'home',
  body: { nodes, rootNodeId: homeRoot },
  seoTitle: 'Kitchen Remodeling & Granite Countertops | Worcester MA',
  seoDescription: 'Family-owned kitchen and bath remodeling. Free estimates, lifetime warranty.',
  templateEnabled: true, templateTarget: { kind: 'everywhere' }, templatePriority: 90,
}, 'page Homepage (template)')

resetNodes()
const contactRoot = ctn('contact-root', ['title', 'form-ref'])
txt('title', 'Contact Us', 'h1')
n('form-ref', 'base.visual-component-ref', { componentId: componentIds['lead-form'], propOverrides: {} })
await upsertRow('pages', 'contact', {
  title: 'Contact — Get Your Free Estimate', slug: 'contact',
  body: { nodes, rootNodeId: contactRoot },
  seoTitle: 'Contact Granite Brothers | Free Estimates',
  templateEnabled: true, templateTarget: { kind: 'everywhere' }, templatePriority: 80,
}, 'page Contact/Lead (template)')

resetNodes()
const aboutRoot = ctn('about-root', ['title', 'p1', 'p2', 'features-ref'])
txt('title', 'About Granite Brothers', 'h1')
txt('p1', 'Three generations of Central Massachusetts craftsmen. We have completed 2,400+ projects since 1998.', 'p')
txt('p2', 'Every crew member is background-checked, and every job is backed by our lifetime workmanship warranty.', 'p')
n('features-ref', 'base.visual-component-ref', { componentId: componentIds['features'], propOverrides: {} })
await upsertRow('pages', 'about', {
  title: 'About Us — Granite Brothers', slug: 'about',
  body: { nodes, rootNodeId: aboutRoot },
  templateEnabled: true, templateTarget: { kind: 'everywhere' }, templatePriority: 70,
}, 'page About')

// 5. Demo entries (fully filled per plan Phase 1)
await upsertRow('services', 'granite-countertops', {
  title: 'Granite Countertops', slug: 'granite-countertops',
  heroHeadline: 'Granite Countertops in Worcester, MA', heroSubtext: 'Template to install in as little as one week.',
  body: '<p>Choose from 400+ slabs in our Sturbridge yard. Digital templating ensures a perfect fit; our in-house fabricators cut, polish, and seal every top before our install crew arrives.</p>',
  faqs: 'How long does install take? | Most kitchens are templated day one and installed within 7 days.\nDo you seal the granite? | Yes — every top is sealed twice and comes with care instructions.',
  seoTitle: 'Granite Countertops Worcester MA | Granite Brothers',
  seoDescription: 'Custom granite countertops, fabricated in-house and installed in about a week. Free estimates in Worcester County.',
}, 'demo service Granite Countertops')

await upsertRow('cities', 'worcester', {
  title: 'Worcester', slug: 'worcester', state: 'MA',
  heroHeadline: 'Kitchen Remodeling in Worcester, MA', heroSubtext: 'Serving the 508 — from Shrewsbury St to Tatnuck.',
  body: '<p>Worcester is our home base. Our crews work the city daily, pulling permits with the DPW and knowing local inspectors by name.</p>',
  neighborhoods: 'Tatnuck\nWest Side\nShrewsbury Street\nBurncoat\nGreendale',
  phone: '(555) 123-4567',
  seoTitle: 'Kitchen Remodeling Worcester MA | Granite Brothers',
  seoDescription: 'Worcester kitchen remodeling and granite countertops from a local, licensed crew. Free estimates.',
}, 'demo city Worcester')

// Demo blog post
await upsertRow('posts', 'why-granite-countertops', {
  title: 'Why Granite Countertops Are the Smart Choice for Your Kitchen', slug: 'why-granite-countertops',
  body: '<p>Granite has been the gold standard for kitchen countertops for decades — and for good reason. When you choose granite, you\'re investing in a surface that combines timeless beauty with unmatched durability.</p><h2>Natural Beauty, Every Slab Unique</h2><p>No two granite slabs are identical. Each piece tells a geological story millions of years in the making, with distinctive veining, speckling, and color variations that engineered stone simply cannot replicate. Our Sturbridge yard carries over 400 slabs so you can hand-pick the exact look for your kitchen.</p><h2>Heat & Scratch Resistance</h2><p>Hot pots straight from the stove? No problem. Granite handles temperatures up to 1,200°F without scorching or cracking. It\'s also highly scratch-resistant — knives won\'t leave marks, though we still recommend using a cutting board to protect your blades.</p><h2>Lifetime Value</h2><p>Properly sealed granite countertops last 50+ years. Our fabrication includes a 15-year sealer that repels stains from wine, oil, and acidic foods. Routine care is simple: wipe with mild soap and water, reseal every few years.</p><h2>Boosts Home Value</h2><p>Kitchen remodels with granite countertops consistently return 70–80% of cost at resale. Buyers in Greater Worcester recognize quality — they know Granite Brothers work when they see it.</p>',
  featuredImage: null,
  excerpt: 'Granite countertops offer unmatched durability, natural beauty, and lifetime value. Learn why they\'re the smart choice for your Worcester kitchen remodel.',
  author: 'Granite Brothers',
  publishedAt: '2026-09-15',
  seoTitle: 'Why Granite Countertops Are the Smart Choice | Granite Brothers',
  seoDescription: 'Discover why granite countertops are the best investment for your kitchen — heat resistant, scratch proof, unique natural beauty, and 50+ year lifespan.',
}, 'demo blog post')

console.log('\n✅ Done. All rows upserted and published.')
process.exit(0)