/**
 * SEO admin surface (Phase 1.5) — redirect manager + SEO settings.
 *
 *   GET    /admin/api/cms/seo/settings            — SEO settings + publisher identity + robots.txt
 *   PUT    /admin/api/cms/seo/settings            — patch SEO settings (partial)
 *   PUT    /admin/api/cms/seo/publisher-identity  — patch publisher identity (partial)
 *   GET    /admin/api/cms/seo/robots              — current robots.txt body
 *   PUT    /admin/api/cms/seo/robots              — replace robots.txt body (raw text)
 *   GET    /admin/api/cms/seo/redirects           — list all redirects
 *   POST   /admin/api/cms/seo/redirects           — create/upsert one redirect
 *   PATCH  /admin/api/cms/seo/redirects/:id       — update one redirect
 *   DELETE /admin/api/cms/seo/redirects/:id       — delete one redirect
 *   POST   /admin/api/cms/seo/redirects/import    — CSV import (?replace=true wipes table first)
 *   GET    /admin/api/cms/seo/redirects/export    — CSV export (text/csv download)
 *
 * Like the publish group, every route here addresses the LIVE site only —
 * the seo repository is single-site and branch-free — so this group never
 * receives a `BranchScope`. Reads gate on `site.read`; every mutation gates
 * on `site.structure.edit` (same bar as full-site import).
 */
import { requireCapability } from '../../auth/authz'
import {
  badRequest,
  jsonResponse,
  payloadTooLarge,
  readTextBodyWithLimit,
  readValidatedBody,
} from '../../http'
import { Type } from '@core/utils/typeboxHelpers'
import {
  PublisherIdentitySchema,
  RedirectStatusCodes,
  SeoSettingsSchema,
} from '@core/seo/types'
import * as seoRepo from '../../repositories/seo'
import type { DbClient } from '../../db/client'
import { CMS_API_PREFIX } from './shared'
import { runRouteTable, type Route, type RouteParams } from './routeTable'

const RedirectStatusCodeSchema = Type.Union(
  RedirectStatusCodes.map((code) => Type.Literal(code)),
)

const CreateRedirectBodySchema = Type.Object({
  fromPath: Type.String({ minLength: 1 }),
  targetPath: Type.String({ minLength: 1 }),
  statusCode: Type.Optional(RedirectStatusCodeSchema),
  isRegex: Type.Optional(Type.Boolean()),
  enabled: Type.Optional(Type.Boolean()),
  note: Type.Optional(Type.String()),
})

const PatchRedirectBodySchema = Type.Object({
  fromPath: Type.Optional(Type.String({ minLength: 1 })),
  targetPath: Type.Optional(Type.String({ minLength: 1 })),
  statusCode: Type.Optional(RedirectStatusCodeSchema),
  isRegex: Type.Optional(Type.Boolean()),
  enabled: Type.Optional(Type.Boolean()),
  note: Type.Optional(Type.String()),
})

const SettingsPatchBodySchema = Type.Partial(SeoSettingsSchema)

const IdentityPatchBodySchema = Type.Partial(PublisherIdentitySchema)

/** 2 MB CSV ceiling — thousands of redirect rows, well under it. */
const CSV_MAX_BYTES = 2_000_000
/** 1 MB robots.txt ceiling — generous for any hand-written file. */
const ROBOTS_MAX_BYTES = 1_000_000

interface IdParams extends RouteParams {
  id: string
}

const SEO_ROUTES: readonly Route<[]>[] = [
  // ---- settings / identity / robots ----
  {
    method: 'GET',
    pattern: `${CMS_API_PREFIX}/seo/settings`,
    handler: async (req, db) => {
      await requireCapability(req, db, 'site.read')
      const [settings, publisherIdentity, robotsTxt] = await Promise.all([
        seoRepo.getSiteSeoSettings(db),
        seoRepo.getPublisherIdentity(db),
        seoRepo.getRobotsTxt(db),
      ])
      return jsonResponse({ settings, publisherIdentity, robotsTxt })
    },
  },
  {
    method: 'PUT',
    pattern: `${CMS_API_PREFIX}/seo/settings`,
    handler: async (req, db) => {
      await requireCapability(req, db, 'site.structure.edit')
      const patch = await readValidatedBody(req, SettingsPatchBodySchema)
      if (!patch) return badRequest('Invalid SEO settings body')
      const settings = await seoRepo.setSiteSeoSettings(db, patch)
      return jsonResponse({ settings })
    },
  },
  {
    method: 'PUT',
    pattern: `${CMS_API_PREFIX}/seo/publisher-identity`,
    handler: async (req, db) => {
      await requireCapability(req, db, 'site.structure.edit')
      const patch = await readValidatedBody(req, IdentityPatchBodySchema)
      if (!patch) return badRequest('Invalid publisher identity body')
      const publisherIdentity = await seoRepo.setPublisherIdentity(db, patch)
      return jsonResponse({ publisherIdentity })
    },
  },
  {
    method: 'GET',
    pattern: `${CMS_API_PREFIX}/seo/robots`,
    handler: async (req, db) => {
      await requireCapability(req, db, 'site.read')
      return jsonResponse({ robotsTxt: await seoRepo.getRobotsTxt(db) })
    },
  },
  {
    method: 'PUT',
    pattern: `${CMS_API_PREFIX}/seo/robots`,
    handler: async (req, db) => {
      await requireCapability(req, db, 'site.structure.edit')
      let body: string
      try {
        body = await readTextBodyWithLimit(req, ROBOTS_MAX_BYTES)
      } catch {
        return payloadTooLarge('robots.txt exceeds the 1 MB limit')
      }
      const robotsTxt = await seoRepo.setRobotsTxt(db, body)
      return jsonResponse({ robotsTxt })
    },
  },
  // ---- redirect manager ----
  {
    method: 'GET',
    pattern: `${CMS_API_PREFIX}/seo/redirects`,
    handler: async (req, db) => {
      await requireCapability(req, db, 'site.read')
      return jsonResponse({ redirects: await seoRepo.listSiteRedirects(db) })
    },
  },
  {
    method: 'POST',
    pattern: `${CMS_API_PREFIX}/seo/redirects/import`,
    handler: async (req, db) => {
      await requireCapability(req, db, 'site.structure.edit')
      const replace = new URL(req.url).searchParams.get('replace') === 'true'
      let csv: string
      try {
        csv = await readTextBodyWithLimit(req, CSV_MAX_BYTES)
      } catch {
        return payloadTooLarge('CSV exceeds the 2 MB import limit')
      }
      const result = await seoRepo.importRedirectsCsv(db, csv, { replace })
      return jsonResponse(result)
    },
  },
  {
    method: 'GET',
    pattern: `${CMS_API_PREFIX}/seo/redirects/export`,
    handler: async (req, db) => {
      await requireCapability(req, db, 'site.read')
      const csv = await seoRepo.exportRedirectsCsv(db)
      return new Response(csv, {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="redirects.csv"',
        },
      })
    },
  },
  {
    method: 'POST',
    pattern: `${CMS_API_PREFIX}/seo/redirects`,
    handler: async (req, db) => {
      await requireCapability(req, db, 'site.structure.edit')
      const body = await readValidatedBody(req, CreateRedirectBodySchema)
      if (!body) return badRequest('Invalid redirect body')
      const redirect = await seoRepo.createSiteRedirect(db, body)
      return jsonResponse({ redirect }, { status: 201 })
    },
  },
  {
    method: 'PATCH',
    pattern: new RegExp(`^${CMS_API_PREFIX}/seo/redirects/(?<id>[^/]+)$`),
    handler: async (req, db, params) => {
      await requireCapability(req, db, 'site.structure.edit')
      const { id } = params as IdParams
      const body = await readValidatedBody(req, PatchRedirectBodySchema)
      if (!body) return badRequest('Invalid redirect patch body')
      const redirect = await seoRepo.updateSiteRedirect(db, { id, ...body })
      if (!redirect) return jsonResponse({ error: 'Redirect not found' }, { status: 404 })
      return jsonResponse({ redirect })
    },
  },
  {
    method: 'DELETE',
    pattern: new RegExp(`^${CMS_API_PREFIX}/seo/redirects/(?<id>[^/]+)$`),
    handler: async (req, db, params) => {
      await requireCapability(req, db, 'site.structure.edit')
      const { id } = params as IdParams
      const existing = await seoRepo.getSiteRedirectById(db, id)
      if (!existing) return jsonResponse({ error: 'Redirect not found' }, { status: 404 })
      await seoRepo.deleteSiteRedirect(db, id)
      return jsonResponse({ ok: true })
    },
  },
]

export async function handleSeoRoutes(
  req: Request,
  db: DbClient,
): Promise<Response | null> {
  return runRouteTable(req, db, SEO_ROUTES)
}
