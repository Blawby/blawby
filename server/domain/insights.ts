import { dashboardPresentation } from '~/shared/dashboard-presentation'
import { HTTPError } from 'nitro'
import { executeBatch, type BatchQuery, type DbClient } from '~/server/db'
import type { CloudflareEnv } from '~/server/utils/auth'
import { localDateBounds, parseAnalyticsRange } from '~/server/utils/analytics-calendar'
import { assignedGuestThreadScope, BATCH_VIEWER, roleAllows } from '~/server/utils/member-access'
import { loadInstagramInsights } from '~/server/utils/instagram-insights'
import { loadGoogleAdsInsights } from '~/server/utils/google-ads-insights'
import { bookingDay } from '~/server/domain/requests'
import { setupQueries, setupViews } from '~/server/domain/opportunities'
import { roleMatchesSql, rolesAllowing } from '~/utils/organization-access'
import { ATTRIBUTION_CHANNELS } from '~/utils/analytics-attribution'
import { addLocalDays, formatCalendarDate, localDateAt } from '~/utils/timezone'
import { paymentMoney } from '~/shared/payment-display'
import { REVIEW_CATEGORIES, reviewSubject } from '~/shared/review-questions'
import {
  INSIGHTS_CLICKS, INSIGHTS_KINDS, INSIGHTS_KIND_LABELS, INSIGHTS_PAGES, clickKey, bookerWord, insightsIndexSchema, insightsOverviewSchema, insightsPage, insightsPageSchema, offeringsWord, pageKinds, pageShown, pageTitle, sectionTitle,
  type InsightsIndex, type InsightsKind, type InsightsKindFilter, type InsightsPage, type InsightsPageDefinition, type InsightsStoredPageId,
} from '~/shared/insights'

/**
 * The Insights pages, read from the stored records each number is about:
 * reviews, bookings, nights, payments, and the day counts the visit write keeps
 * (server/utils/pageview-tracking.ts). Every page is one D1 batch of
 * independent statements; nothing is summarized ahead of time. Marketing pages
 * are read from Instagram and Google Ads as they open. Every string a screen
 * draws is composed here.
 */

export interface InsightsReader {
  organizationId: string
  /** The dashboard's address for the business, for the links a page offers. */
  slug: string
  timezone: string
  defaultCurrency: string
  userId: string
  /** Reads every page; otherwise only Quality, for the visits this member looks after. */
  analytics: boolean
}

/** Who may read which pages, by the role's own permissions. A role with neither reads nothing. */
export async function insightsReader(organization: { id: string; slug: string; role: string; timezone: string; default_currency: string }, userId: string): Promise<InsightsReader> {
  const analytics = await roleAllows({ organizationId: organization.id, role: organization.role, permissions: { analytics: ['read'] } })
  if (!analytics && !await roleAllows({ organizationId: organization.id, role: organization.role, permissions: { operations: ['assigned'] } })) {
    throw new HTTPError({ statusCode: 403, message: 'Access denied', data: { code: 'FORBIDDEN', field: 'permissions' } })
  }
  return { organizationId: organization.id, slug: organization.slug, timezone: organization.timezone, defaultCurrency: organization.default_currency, userId, analytics }
}

type Row = Record<string, unknown>
const rowsOf = (result: { results?: unknown[] } | undefined) => (result?.results ?? []) as Row[]
const text = (value: unknown) => typeof value === 'string' ? value : null
const num = (value: unknown) => Number(value ?? 0)

/** What the business books (its homes, and the offerings it takes bookings for), whether it has a menu, and its locations: one statement. */
type InsightsScope = { sql: string; params: unknown[] }
const organizationScope = (organizationId: string): InsightsScope => ({ sql: '?', params: [organizationId] })
const assignedReviewScope = (scope: InsightsScope): InsightsScope => ({
  sql: `EXISTS (SELECT 1 FROM bookings visit JOIN conversations q ON q.organization_id = visit.organization_id AND q.booking_id = visit.id AND q.kind = 'booking'
    WHERE visit.organization_id = r.organization_id AND visit.id = r.booking_id AND ${scope.sql})`, params: scope.params,
})
const businessQuery = (organization: InsightsScope): BatchQuery => ({
  query: `SELECT
    (SELECT json_group_array(kind) FROM (SELECT DISTINCT p.kind FROM products p WHERE p.organization_id = o.id AND (
      (p.kind = 'stay' AND EXISTS (SELECT 1 FROM product_stay_configs s WHERE s.organization_id = p.organization_id AND s.product_id = p.id))
      OR (p.kind IN ('experience', 'service', 'table') AND EXISTS (SELECT 1 FROM product_booking_configs c WHERE c.organization_id = p.organization_id AND c.product_id = p.id))))) AS kinds,
    EXISTS (SELECT 1 FROM products WHERE organization_id = o.id AND kind = 'dish') AS has_menu,
    (SELECT json_group_array(json_object('id', id, 'title', title)) FROM business_locations WHERE organization_id = o.id) AS locations
    FROM organization o WHERE o.id = ${organization.sql}`,
  params: organization.params
})
interface Business { booked: InsightsKind[]; hasMenu: boolean; locations: Array<{ id: string; title: string }> }
function business(row: Row | undefined): Business {
  if (!row) throw new HTTPError({ statusCode: 404, message: 'Organization not found', data: { code: 'ORGANIZATION_NOT_FOUND', field: 'org' } })
  const kinds = new Set(JSON.parse(String(row.kinds)) as string[])
  const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
  return {
    booked: INSIGHTS_KINDS.filter(kind => kinds.has(kind)),
    hasMenu: num(row.has_menu) === 1,
    locations: (JSON.parse(String(row.locations)) as Array<{ id: string; title: string }>).sort((a, b) => order(a.title, b.title) || order(a.id, b.id)),
  }
}
/** The kinds a page is about, of those the business books: a page is titled in their words. */
const covered = (page: InsightsPageDefinition, booked: readonly InsightsKind[]) => booked.filter(kind => !page.kinds || (page.kinds as readonly string[]).includes(kind))

/** The business's sections and pages, as the list beside a page shows them. */
export function prepareInsightsIndex(organization: InsightsScope = { sql: BATCH_VIEWER.organization, params: [] }) {
  return {
    queries: [businessQuery(organization)], read(reader: InsightsReader, results: D1Result[]): InsightsIndex {
      const { booked } = business(rowsOf(results[0])[0]!)
      const pages = INSIGHTS_PAGES.filter(page => (reader.analytics || page.id === 'quality/overall-rating') && pageShown(page, booked))
      return insightsIndexSchema.parse({
        sections: [...new Set(pages.map(page => page.section))].map(section => ({
          id: section,
          title: sectionTitle(section, booked, 'all'),
          pages: pages.filter(page => page.section === section).map(page => ({ id: page.id, title: pageTitle(page.id, covered(page, booked), 'all') })),
        })),
      })
    }
  }
}

export async function readInsightsIndex(db: DbClient, reader: InsightsReader): Promise<InsightsIndex> {
  const plan = prepareInsightsIndex(organizationScope(reader.organizationId))
  return plan.read(reader, await executeBatch(db, plan.queries, { operation: 'read Insights index' }))
}

export interface InsightsQuery { kind?: string; location_id?: string; start_date?: string; end_date?: string }

/** Auth, membership, opportunities and every overview card can share the caller's D1 batch. */
type InsightsAccess = { organization: InsightsScope; analyticsOrganization: InsightsScope; opportunitiesOrganization: InsightsScope; reviewScope: InsightsScope | null }
function dashboardInsightsAccess(): InsightsAccess {
  const analytics = roleMatchesSql(BATCH_VIEWER.role!, rolesAllowing({ analytics: ['read'] }))
  const suggestions = roleMatchesSql(BATCH_VIEWER.role!, rolesAllowing({ task: ['assign'] }))
  const assigned = assignedReviewScope(assignedGuestThreadScope('q', { column: BATCH_VIEWER.user }))
  return {
    organization: { sql: BATCH_VIEWER.organization, params: [] },
    analyticsOrganization: { sql: `CASE WHEN ${analytics} THEN ${BATCH_VIEWER.organization} END`, params: [] },
    opportunitiesOrganization: { sql: `CASE WHEN ${suggestions} THEN ${BATCH_VIEWER.organization} END`, params: [] },
    reviewScope: { sql: `(${analytics} OR ${assigned.sql})`, params: assigned.params },
  }
}

export function prepareInsightsOverview(db: DbClient, requestedDays: string | undefined, access?: InsightsAccess) {
  const length = requestedDays ?? '7'
  if (!['7', '30', '365'].includes(length)) throw new HTTPError({ statusCode: 400, message: 'days must be 7, 30 or 365', data: { code: 'INVALID_FILTER', field: 'days' } })
  const scope = access ?? dashboardInsightsAccess()
  const now = new Date()
  // UTC bounds cover every possible tenant day. Decoders narrow the returned
  // rows to the saved IANA timezone from this very batch, including DST.
  const utc = localDateAt(now, 'UTC')
  const queryRange = parseAnalyticsRange({ startDate: addLocalDays(utc, 1 - Number(length)), endDate: utc, timeZone: 'UTC', now })
  const broadRange = { ...queryRange, startDate: addLocalDays(queryRange.startDate, -1), endDate: addLocalDays(utc, 1) }
  const setup = setupQueries(scope.opportunitiesOrganization, { now })
  let resolvedReader: InsightsReader | undefined
  const queries = [businessQuery(scope.organization), ...setup]
  const positions = new Map<string, number>()
  const plans = INSIGHTS_PAGES.filter(page => page.section !== 'marketing'
    && !['conversion/page-views', 'conversion/top-pages', 'conversion/sources', 'rates/income-by-channel'].includes(page.id)).map(definition => {
      const context: PageContext = {
        db,
        get reader() { if (!resolvedReader) throw new Error('Insights must resolve its authorized reader before decoding'); return resolvedReader },
        organization: definition.section === 'quality' ? scope.organization : scope.analyticsOrganization, reviewScope: scope.reviewScope,
        definition, kind: 'all', locationId: null, dates: queryRange.dates, range: broadRange,
        window: { from: localDateBounds(broadRange.startDate, 'UTC').start, until: localDateBounds(broadRange.endDate, 'UTC').end }, business: { booked: [], hasMenu: false, locations: [] }
      }
      const plan = PAGE_READS[definition.id as InsightsStoredPageId](context)
      const indices = plan.queries.map(query => {
        const key = JSON.stringify([query.query, query.params ?? []])
        const existing = positions.get(key)
        if (existing !== undefined) return existing
        const index = queries.push(query) - 1
        positions.set(key, index)
        return index
      })
      return { definition, context, plan, indices }
    })
  return {
    queries,
    read(reader: InsightsReader, showOpportunities: boolean, results: D1Result[]) {
      resolvedReader = reader
      const rows = results.map(rowsOf)
      const end = localDateAt(now, reader.timezone)
      const range = parseAnalyticsRange({ startDate: addLocalDays(end, 1 - Number(length)), endDate: end, timeZone: reader.timezone, now })
      const current = business(rows[0]![0]!)
      const opportunities = showOpportunities ? setupViews(rows[1]!, rows[2]!, rows[3]!) : null
      if (showOpportunities && !opportunities) throw new HTTPError({ statusCode: 404, message: 'Organization not found' })
      const reads = plans.flatMap(({ definition, context, plan, indices }) => {
        const values = indices.map(index => rows[index]!)
        context.business = current
        context.range = range
        context.dates = range.dates
        context.window = { from: localDateBounds(range.startDate, reader.timezone).start, until: localDateBounds(range.endDate, reader.timezone).end }
        return (reader.analytics || definition.section === 'quality') && pageShown(definition, current.booked) ? [{ definition, read: plan.read(values) }] : []
      })
      const metric = (page: string, key?: string) => {
        const result = reads.find(result => result.definition.id === page)
        const value = key ? result?.read.metrics.find(metric => metric.key === key) : result?.read.metrics[0]
        return value && result ? { page, key: value.key, label: value.label, display: value.value === null ? '—' : formatter(value.format, result.read.currency ?? null)(value.value) } : null
      }
      const quality = reads.find(result => result.definition.id === 'quality/overall-rating')!.read
      return insightsOverviewSchema.parse({
        presentation: dashboardPresentation,
        range: { start_date: range.startDate, end_date: range.endDate, label: `${formatCalendarDate(range.startDate, 'en', { month: 'short', day: 'numeric', year: 'numeric' })} – ${formatCalendarDate(range.endDate, 'en', { month: 'short', day: 'numeric', year: 'numeric' })}` },
        summary: [metric('rates/occupancy-rate', 'nights_booked'), metric('rates/bookings'), metric('rates/nightly-rate', 'income'), metric('rates/average-value', 'income'), metric('quality/overall-rating', 'five_star')].filter(Boolean),
        sections: ['quality', 'rates', 'conversion'].map(section => ({
          id: section, title: sectionTitle(section as InsightsPageDefinition['section'], current.booked, 'all'),
          metrics: reads.filter(result => result.definition.section === section).flatMap(result => section === 'quality'
            ? result.read.metrics.map(value => metric(result.definition.id, value.key)!) : [metric(result.definition.id)!])
        })).filter(section => section.metrics.length),
        recent_issues: quality.list?.kind === 'reviews' ? quality.list.reviews.filter(review => review.rating < 5).map(({ id, author, line, rating, content }) => ({ id, author, line, rating, content })) : [],
        opportunities: opportunities?.opportunities ?? [],
      })
    }
  }
}

export async function readInsightsOverview(db: DbClient, reader: InsightsReader, requestedDays: string | undefined, showOpportunities: boolean) {
  const organization = organizationScope(reader.organizationId)
  const plan = prepareInsightsOverview(db, requestedDays, {
    organization,
    analyticsOrganization: reader.analytics ? organization : { sql: 'NULL', params: [] },
    opportunitiesOrganization: showOpportunities ? organization : { sql: 'NULL', params: [] },
    reviewScope: reader.analytics ? null : assignedReviewScope(assignedGuestThreadScope('q', reader.userId))
  })
  return plan.read(reader, showOpportunities, await executeBatch(db, plan.queries, { operation: 'read Insights overview' }))
}

const percent = (part: number, whole: number) => whole ? Math.round(part / whole * 1000) / 10 : null
const average = (total: number, count: number, digits = 1) => count ? Math.round(total / count * 10 ** digits) / 10 ** digits : null
const dayDiff = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
const CHANNEL_LABELS: Record<string, string> = { airbnb: 'Airbnb', vrbo: 'Vrbo', booking_com: 'Booking.com' }
const singular = (plural: string) => plural === 'Practice areas' ? 'Practice area' : plural.replace(/s$/, '')
function insightsCurrency(currencies: string[], defaultCurrency: string) {
  const distinct = [...new Set(currencies)]
  if (distinct.length > 1) throw new HTTPError({ statusCode: 409, message: 'Amounts in different currencies cannot be combined', data: { code: 'MULTIPLE_INSIGHTS_CURRENCIES', field: 'currency' } })
  return distinct[0] ?? defaultCurrency
}


/** How a number reads. Money is in the minor units of the page's currency; micros are Google Ads'. */
type Format = 'count' | 'percent' | 'rating' | 'money' | 'micros' | 'nights' | 'days' | 'people' | 'text'
const count = (value: number) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value)
function formatter(format: Format, currency: string | null): (value: number) => string {
  if (format === 'percent') return value => `${count(value)}%`
  if (format === 'rating') return value => new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 2 }).format(value)
  if (format === 'money') return value => paymentMoney(Math.round(value), currency)
  if (format === 'micros') return value => new Intl.NumberFormat('en-US', { style: 'currency', currency: currency! }).format(value / 1_000_000)
  if (format === 'nights') return value => `${count(value)} ${value === 1 ? 'night' : 'nights'}`
  if (format === 'days') return value => `${count(value)} ${value === 1 ? 'day' : 'days'}`
  return count
}
const shortDate = (date: string) => formatCalendarDate(date, 'en', { month: 'short', day: 'numeric' })

/** One headline number and its value on each day. */
interface Metric { key: string; label: string; value: number | null; format: Format; text?: string | null; daily?: Array<number | null> }

/** Per-day accumulators over the range, by the local day each record falls on. */
function days(dates: string[]) {
  const index = new Map(dates.map((date, position) => [date, position]))
  return {
    has: (date: string) => index.has(date),
    sum: <T>(rows: T[], dayOf: (row: T) => string, value: (row: T) => number) => {
      const totals = dates.map(() => 0)
      for (const row of rows) { const at = index.get(dayOf(row)); if (at !== undefined) totals[at]! += value(row) }
      return totals
    },
    each: <T>(rows: T[], dayOf: (row: T) => string, measure: (rows: T[]) => number | null) => {
      const grouped = dates.map(() => [] as T[])
      for (const row of rows) { const at = index.get(dayOf(row)); if (at !== undefined) grouped[at]!.push(row) }
      return grouped.map(group => measure(group))
    },
  }
}

/** Groups rows by offering, in the order of the measure, largest first. */
function byOffering<T extends { product_id: string; product_name: string }>(rows: T[], values: (rows: T[]) => Array<number | null>) {
  const groups = new Map<string, { label: string; rows: T[] }>()
  for (const row of rows) {
    const group = groups.get(row.product_id) ?? { label: row.product_name, rows: [] }
    group.rows.push(row)
    groups.set(row.product_id, group)
  }
  return [...groups].map(([key, group]) => ({ key, label: group.label, values: values(group.rows) }))
    .sort((a, b) => (b.values[0] ?? -1) - (a.values[0] ?? -1) || a.label.localeCompare(b.label))
}

interface BookingRow {
  id: string; product_id: string; product_name: string; kind: InsightsKind; status: string; starts_at: string; ends_at: string; timezone: string
  party_size: number; total_minor: number | null; currency: string | null; channel: string; owner: string; website_source: string | null
  user_id: string | null; created_at: string; received_at: string | null; returning: number
}
const bookingRow = (row: Row): BookingRow => ({
  id: String(row.id), product_id: String(row.product_id), product_name: String(row.product_name), kind: row.kind as InsightsKind, status: String(row.status),
  starts_at: String(row.starts_at), ends_at: String(row.ends_at), timezone: String(row.timezone), party_size: num(row.party_size),
  total_minor: row.total_minor === null ? null : num(row.total_minor), currency: text(row.currency), channel: String(row.channel), owner: String(row.owner),
  website_source: text(row.website_source), user_id: text(row.user_id), created_at: String(row.created_at), received_at: text(row.received_at), returning: num(row.booked_before),
})

/**
 * Reads one page for the reader. The range is the business's own calendar
 * days, the last 30 by default. Bookings & rates count the bookings that
 * start in the range; Conversion counts the bookings made in it (received live:
 * a channel's imported history has no time it was made).
 */
function insightsFilters(pageId: string, query: InsightsQuery) {
  const definition = insightsPage(pageId)
  if (!definition) throw new HTTPError({ statusCode: 404, message: 'Insights page not found', data: { code: 'INSIGHTS_PAGE_NOT_FOUND', field: 'page' } })
  const kind = (query.kind ?? 'all') as InsightsKindFilter
  if (kind !== 'all' && !(INSIGHTS_KINDS as readonly string[]).includes(kind)) throw new HTTPError({ statusCode: 400, message: `kind must be all or one of ${INSIGHTS_KINDS.join(', ')}`, data: { code: 'INVALID_FILTER', field: 'kind' } })
  if (kind !== 'all' && (definition.filters === 'range' || !pageKinds(definition, kind).length)) throw new HTTPError({ statusCode: 400, message: `${pageTitle(definition.id, [kind], kind)} is not read by kind ${kind}`, data: { code: 'INVALID_FILTER', field: 'kind' } })
  const locationId = query.location_id || null
  if (locationId && definition.filters !== 'kind_location') throw new HTTPError({ statusCode: 400, message: 'This page is not read by location', data: { code: 'INVALID_FILTER', field: 'location_id' } })
  return { definition, kind, locationId }
}

/** A metric page joins the same authorized-resource batch as its membership. */
export function prepareStoredInsightsPage(db: DbClient, pageId: string, query: InsightsQuery) {
  const { definition, kind, locationId } = insightsFilters(pageId, query)
  if (definition.section === 'marketing') throw new Error('Marketing reads belong to their provider')
  const access = dashboardInsightsAccess(), now = new Date()
  const utc = localDateAt(now, 'UTC')
  // An omitted boundary is resolved only after the batch returns the tenant's
  // timezone. Query the envelope of all possible local dates in the meantime.
  const queryRange = parseAnalyticsRange({ startDate: query.start_date ?? (query.end_date ? undefined : addLocalDays(utc, -30)), endDate: query.end_date ?? addLocalDays(utc, 1), timeZone: 'UTC', now }, 367)
  const range = {
    ...queryRange, startDate: addLocalDays(queryRange.startDate, -1), endDate: addLocalDays(queryRange.endDate, 1),
    previousStartDate: addLocalDays(queryRange.previousStartDate, -1), previousEndDate: addLocalDays(queryRange.previousEndDate, 3)
  }
  let reader: InsightsReader | undefined
  const context: PageContext = {
    db, definition, kind, locationId,
    get reader() { if (!reader) throw new Error('Insights must resolve its authorized reader before decoding'); return reader },
    organization: definition.section === 'quality' ? access.organization : access.analyticsOrganization, reviewScope: access.reviewScope,
    range, dates: queryRange.dates, window: { from: localDateBounds(range.startDate, 'UTC').start, until: localDateBounds(range.endDate, 'UTC').end }, business: { booked: [], hasMenu: false, locations: [] }
  }
  const plan = PAGE_READS[definition.id as InsightsStoredPageId](context)
  return {
    queries: [businessQuery(access.organization), ...plan.queries], read(resolved: InsightsReader, results: D1Result[]) {
      reader = resolved
      if (!reader.analytics && definition.section !== 'quality') throw new HTTPError({ statusCode: 403, message: 'Access denied', data: { code: 'FORBIDDEN', field: 'permissions' } })
      context.range = parseAnalyticsRange({ startDate: query.start_date, endDate: query.end_date, timeZone: reader.timezone, now })
      context.dates = context.range.dates
      context.window = { from: localDateBounds(context.range.startDate, reader.timezone).start, until: localDateBounds(context.range.endDate, reader.timezone).end }
      const [businessRows, ...rows] = results.map(rowsOf)
      context.business = business(businessRows![0]!)
      return formatInsightsPage(context, plan.read(rows))
    }
  }
}

export async function readInsightsPage(db: DbClient, reader: InsightsReader, pageId: string, query: InsightsQuery, env: CloudflareEnv): Promise<InsightsPage> {
  const { definition, kind, locationId } = insightsFilters(pageId, query)
  if (!reader.analytics && definition.id !== 'quality/overall-rating') throw new HTTPError({ statusCode: 403, message: 'Access denied', data: { code: 'FORBIDDEN', field: 'permissions' } })
  const range = parseAnalyticsRange({ startDate: query.start_date || undefined, endDate: query.end_date || undefined, timeZone: reader.timezone, now: new Date() })
  const window = { from: localDateBounds(range.startDate, reader.timezone).start, until: localDateBounds(range.endDate, reader.timezone).end }
  const context: PageContext = { db, reader, organization: organizationScope(reader.organizationId), reviewScope: reader.analytics ? null : assignedReviewScope(assignedGuestThreadScope('q', reader.userId)), definition, kind, locationId, dates: range.dates, range, window, business: { booked: [], hasMenu: false, locations: [] } }
  const read = definition.section === 'marketing'
    ? await MARKETING_READS[definition.id as keyof typeof MARKETING_READS](env, context)
    : await readStoredPage(context)
  return formatInsightsPage(context, read)
}

function formatInsightsPage(context: PageContext, read: PageRead): InsightsPage {
  const { definition, kind, locationId, range } = context
  const { booked, hasMenu, locations } = context.business
  const kinds = covered(definition, booked)
  if (!pageShown(definition, booked)) throw new HTTPError({ statusCode: 404, message: 'Insights page not found', data: { code: 'INSIGHTS_PAGE_NOT_FOUND', field: 'page' } })
  if (kind !== 'all' && !booked.includes(kind)) throw new HTTPError({ statusCode: 400, message: 'This business does not book that kind', data: { code: 'INVALID_FILTER', field: 'kind' } })
  if (locationId && !locations.some(location => location.id === locationId)) throw new HTTPError({ statusCode: 404, message: 'Location not found', data: { code: 'LOCATION_NOT_FOUND', field: 'location_id' } })

  // One chip names what is shown and opens the kinds and locations the page reads, when there is more than one of either.
  const choices = [
    ...definition.filters !== 'range' && kinds.length > 1 ? [{
      param: 'kind' as const, legend: 'What', selected: kind,
      options: [{ value: 'all', label: 'All offerings' }, ...kinds.map(value => ({ value, label: INSIGHTS_KIND_LABELS[value] }))]
    }] : [],
    ...definition.filters === 'kind_location' && locations.length > 1 ? [{
      param: 'location_id' as const, legend: 'Location', selected: locationId ?? 'all',
      options: [{ value: 'all', label: 'All locations' }, ...locations.map(location => ({ value: location.id, label: location.title }))]
    }] : [],
  ]
  const chosen = (param: string, value: string) => choices.find(choice => choice.param === param)?.options.find(option => option.value === value)?.label
  const show = (format: Format) => formatter(format, read.currency ?? null)
  const list = read.list
  return insightsPageSchema.parse({
    title: pageTitle(definition.id, kinds, kind),
    subtitle: read.subtitle ?? null,
    note: hasMenu && (definition.section === 'rates' || definition.id === 'conversion/booking-conversion')
      ? 'Your menu is not booked, so its dishes count only under Page views and Top pages.' : read.note ?? null,
    action: read.action ?? null,
    filters: {
      offering: choices.length ? { label: [chosen('kind', kind) ?? 'All offerings', locationId ? chosen('location_id', locationId) : null].filter(Boolean).join(' · '), choices } : null,
      range: { start_date: range.startDate, end_date: range.endDate, start_label: shortDate(range.startDate), end_label: shortDate(range.endDate) },
    },
    metrics: read.metrics.map(metric => ({
      key: metric.key, label: metric.label, chartable: !!metric.daily,
      display: metric.format === 'text' ? metric.text ?? '—' : metric.value === null ? '—' : show(metric.format)(metric.value)
    })),
    series: {
      dates: range.dates.map(date => ({ date, label: shortDate(date) })),
      charts: Object.fromEntries(read.metrics.filter(metric => metric.daily).map(metric => [metric.key, chart(metric, show(metric.format))])),
    },
    list: !list ? null : list.kind === 'reviews' ? { ...list, empty: `Once ${bookerWord(booked, kind) === 'clients' ? 'a client' : bookerWord(booked, kind) === 'diners' ? 'a diner' : 'a guest'} reviews a visit in this range, the review will appear here.` } : {
      kind: 'rows', heading: list.heading, columns: list.columns.map(column => ({ label: column.label })), empty: 'Nothing in this range matches these filters.',
      rows: list.rows.map(row => ({ key: row.key, label: row.label, cells: row.values.map((value, position) => value === null ? '—' : show(list.columns[position]!.format)(value)) })),
    },
  })
}

/** A number's chart: five ticks from zero to a round top, the unit written on the bottom and top tick only, and each day as its bar reads. */
function chart(metric: Metric, show: (value: number) => string) {
  const top = Math.max(0, ...metric.daily!.filter((value): value is number => value !== null))
  const maximum = top <= 4 ? 4 : Math.ceil(top / 4) * 4
  const label = metric.label.toLowerCase()
  const bare = metric.format === 'nights' || metric.format === 'days' ? count : show
  return {
    axis: [0, 1, 2, 3, 4].map(step => ({ value: maximum * step / 4, label: (step === 0 || step === 4 ? show : bare)(maximum * step / 4) })),
    points: metric.daily!.map(value => ({ value, display: value === null ? `No ${label}` : `${show(value)} ${label}` })),
  }
}

interface PageContext {
  organization: InsightsScope
  reviewScope: InsightsScope | null
  db: DbClient
  reader: InsightsReader
  definition: InsightsPageDefinition
  kind: InsightsKindFilter
  locationId: string | null
  dates: string[]
  range: ReturnType<typeof parseAnalyticsRange>
  /** The range as instants: [from, until). */
  window: { from: string; until: string }
  /** What the business books, its menu and locations, read in the page's batch: the page's words and choices follow it. */
  business: Business
}
type Review = Extract<NonNullable<InsightsPage['list']>, { kind: 'reviews' }>['reviews'][number]
interface PageRead {
  metrics: Metric[]
  list: { kind: 'rows'; heading: string; columns: Array<{ label: string; format: Format }>; rows: Array<{ key: string; label: string; values: Array<number | null> }> }
  | { kind: 'reviews'; reviews: Review[] } | null
  subtitle?: string
  note?: string
  action?: { label: string; to: string }
  currency?: string
}

/** The bookings of the page's kinds (and location), in a window of one of their times. */
function bookingsQuery(context: PageContext, window: 'starts' | 'received', where = ''): BatchQuery {
  const kinds = pageKinds(context.definition, context.kind)
  // A booking starts on its own local day; the instants a day wider either side are narrowed in code.
  const bounds = window === 'starts'
    ? { sql: 'b.starts_at >= ? AND b.starts_at < ?', params: [addLocalDays(context.range.startDate, -1), addLocalDays(context.range.endDate, 2)] }
    : { sql: 'b.received_at >= ? AND b.received_at < ?', params: [context.window.from, context.window.until] }
  return {
    query: `SELECT b.id, b.product_id, p.name AS product_name, p.kind, b.status, b.starts_at, b.ends_at, b.timezone, b.party_size, b.total_minor, b.currency,
        b.channel, b.owner, b.website_source, b.user_id, b.created_at, b.received_at,
        b.user_id IS NOT NULL AND EXISTS (SELECT 1 FROM bookings e WHERE e.organization_id = b.organization_id AND e.user_id = b.user_id AND e.created_at < b.created_at) AS booked_before
      FROM bookings b JOIN products p ON p.organization_id = b.organization_id AND p.id = b.product_id
      WHERE b.organization_id = ${context.organization.sql} AND p.kind IN (SELECT value FROM json_each(?)) ${context.locationId ? 'AND b.location_id = ?' : ''} AND ${bounds.sql} ${where}`,
    params: [...context.organization.params, JSON.stringify(kinds), ...(context.locationId ? [context.locationId] : []), ...bounds.params],
  }
}

/** Read the report's bookings once and total each ledger before joining it; a page's own further statements ride the same batch. */
function bookingsWithIncome(context: PageContext, also: BatchQuery[] = []) {
  const bookings = bookingsQuery(context, 'starts')
  const organization = context.organization
  const queries: BatchQuery[] = [{
    query: `WITH scoped AS (${bookings.query}),
      online AS (
        SELECT p.subject_id AS booking_id, SUM(p.captured_amount - p.refunded_amount) AS amount, SUM(p.refunded_amount) AS refunded, json_group_array(DISTINCT p.currency) AS currencies
          FROM payments p JOIN scoped b ON b.id = p.subject_id
         WHERE p.organization_id = ${context.organization.sql} AND p.subject_type = 'booking' AND p.captured_amount > 0 GROUP BY p.subject_id
      ),
      offline AS (
        SELECT p.booking_id, SUM(p.amount_minor) AS amount, SUM(-MIN(p.amount_minor, 0)) AS refunded, json_group_array(DISTINCT p.currency) AS currencies
          FROM offline_payments p JOIN scoped b ON b.id = p.booking_id
         WHERE p.organization_id = ${context.organization.sql} AND p.purpose <> 'deposit' GROUP BY p.booking_id
      )
      SELECT b.*, online.amount AS online_amount, online.refunded AS online_refunded,
             offline.amount AS offline_amount, offline.refunded AS offline_refunded, online.currencies AS online_currencies, offline.currencies AS offline_currencies
        FROM scoped b LEFT JOIN online ON online.booking_id = b.id LEFT JOIN offline ON offline.booking_id = b.id`,
    params: [...bookings.params!, ...organization.params, ...organization.params],
  }, ...also]
  return {
    queries, read([rows, ...alsoRows]: Row[][]) {
      const income = rows!.map(row => ({
        ...bookingRow(row),
        online_amount: row.online_amount === null ? null : num(row.online_amount),
        online_refunded: num(row.online_refunded),
        offline_amount: row.offline_amount === null ? null : num(row.offline_amount),
        offline_refunded: num(row.offline_refunded),
        currencies: [...(row.online_amount === null ? [] : JSON.parse(String(row.online_currencies)) as string[]), ...(row.offline_amount === null ? [] : JSON.parse(String(row.offline_currencies)) as string[])],
      })).filter(inRange(context))
      return { bookings: income, also: alsoRows }
    }
  }
}

const startDay = (row: BookingRow) => bookingDay(row.starts_at, row.timezone)
const receivedDay = (context: PageContext) => (row: BookingRow) => localDateAt(new Date(row.received_at!), context.reader.timezone)
const inRange = (context: PageContext) => (row: BookingRow) => context.dates.includes(startDay(row))
const nightsOf = (row: BookingRow) => dayDiff(startDay(row), bookingDay(row.ends_at, row.timezone))

/** A stored page and its business context share one D1 round trip. */
async function readStoredPage(context: PageContext): Promise<PageRead> {
  const plan = PAGE_READS[context.definition.id as InsightsStoredPageId](context)
  const rows = (await executeBatch(context.db, [...plan.queries, businessQuery(context.organization)], { operation: 'read Insights page' })).map(rowsOf)
  context.business = business(rows.pop()![0]!)
  return plan.read(rows)
}

/** A review's state when it is not published. */
export const insightsReviewEligibility = "((r.booking_id IS NOT NULL AND r.status <> 'rejected') OR (r.booking_id IS NULL AND r.status = 'approved'))"

const REVIEW_STATUS = { pending: 'Awaiting review', rejected: 'Not published', private: 'Private' } as const

interface PageReadPlan { queries: BatchQuery[]; read: (rows: Row[][]) => PageRead }
const PAGE_READS: Record<InsightsStoredPageId, (context: PageContext) => PageReadPlan> = {
  'quality/overall-rating': (context) => {
    // A booked visit's review counts unless it was rejected; one left without a visit counts once it is published.
    const scope = context.reviewScope
    const kinds = context.kind === 'all' ? null : pageKinds(context.definition, context.kind)
    const written = 'COALESCE(r.original_review_date, r.created_at)'
    const queries: BatchQuery[] = [{
      query: `SELECT r.id, r.author_name, r.rating, r.status, r.title, r.content, r.private_feedback, ${written} AS written_at,
          p.kind AS product_kind, COALESCE(p.name, bl.title) AS subject,
          (SELECT CASE WHEN b.product_session_id IS NULL THEN 'stay' ELSE 'booking' END FROM bookings b WHERE b.organization_id = r.organization_id AND b.id = r.booking_id) AS booking_type,
          (SELECT json_group_array(json_object('category', c.category, 'rating', c.rating)) FROM review_category_ratings c WHERE c.review_id = r.id) AS categories
        FROM reviews r
        LEFT JOIN products p ON p.organization_id = r.organization_id AND p.id = r.product_id
        LEFT JOIN business_locations bl ON bl.organization_id = r.organization_id AND bl.id = r.location_id
        WHERE r.organization_id = ${context.organization.sql} AND ${written} >= ? AND ${written} < ?
          AND ${insightsReviewEligibility}
          ${kinds ? 'AND p.kind IN (SELECT value FROM json_each(?))' : ''}
          ${context.locationId ? 'AND r.location_id = ?' : ''}
          ${scope ? `AND ${scope.sql}` : ''}
        ORDER BY ${written} DESC, r.id`,
      params: [...context.organization.params, addLocalDays(context.range.startDate, -1), addLocalDays(context.range.endDate, 2),
      ...(kinds ? [JSON.stringify(kinds)] : []), ...(context.locationId ? [context.locationId] : []), ...(scope?.params ?? [])],
    }]
    return {
      queries,
      read(results: Row[][]): PageRead {
        const [rows] = results
        const reviews = rows!.map((row) => {
          const writtenAt = String(row.written_at)
          const date = writtenAt.length === 10 ? writtenAt : localDateAt(new Date(writtenAt), context.reader.timezone)
          const questions = row.booking_type ? reviewSubject(row.booking_type as 'booking' | 'stay', text(row.product_kind)) : null
          const categories = (JSON.parse(String(row.categories)) as Array<{ category: string; rating: number }>).map(rating => `${questions
            ? (REVIEW_CATEGORIES[questions] as ReadonlyArray<{ key: string; label: string }>).find(question => question.key === rating.category)?.label ?? rating.category : rating.category} ${rating.rating}`)
          return {
            date, rating: num(row.rating), review: {
              id: String(row.id), author: String(row.author_name), rating: num(row.rating),
              status: REVIEW_STATUS[row.status as keyof typeof REVIEW_STATUS] ?? null, line: [text(row.subject), formatCalendarDate(date, 'en')].filter(Boolean).join(' · '),
              categories: categories.join(' · ') || null, title: text(row.title), content: text(row.content), private_feedback: text(row.private_feedback)
            }
          }
        }).filter(review => context.dates.includes(review.date))
        const day = days(context.dates)
        const at = (review: { date: string }) => review.date
        return {
          metrics: [
            {
              key: 'overall_rating', label: 'Overall rating', format: 'rating', value: average(reviews.reduce((sum, review) => sum + review.rating, 0), reviews.length, 2),
              daily: day.each(reviews, at, group => average(group.reduce((sum, review) => sum + review.rating, 0), group.length, 2))
            },
            {
              key: 'five_star', label: '5-star ratings', format: 'percent', value: percent(reviews.filter(review => review.rating === 5).length, reviews.length),
              daily: day.each(reviews, at, group => percent(group.filter(review => review.rating === 5).length, group.length))
            },
            { key: 'reviews', label: 'Reviews', format: 'count', value: reviews.length, daily: day.sum(reviews, at, () => 1) },
          ],
          list: { kind: 'reviews', reviews: reviews.map(review => review.review) },
        }
      },
    }
  },

  'rates/occupancy-rate': (context) => {
    const { locationId } = context
    const home = `JOIN product_stay_configs c ON c.organization_id = n.organization_id AND c.product_id = n.product_id ${locationId ? 'AND c.location_id = ?' : ''}`
    const homeParams = locationId ? [locationId] : []
    const queries: BatchQuery[] = [
      {
        query: `SELECT p.id, p.name, p.created_at FROM products p JOIN product_stay_configs c ON c.organization_id = p.organization_id AND c.product_id = p.id
          WHERE p.organization_id = ${context.organization.sql} AND p.kind = 'stay' AND p.active = 1 ${locationId ? 'AND c.location_id = ?' : ''}`,
        params: [...context.organization.params, ...homeParams]
      },
      // stay_nights holds each reservation's nights once, on the home it is on; a merged home's reservations moved there with it.
      {
        query: `SELECT n.product_id, n.date FROM stay_nights n ${home}
          WHERE n.organization_id = ${context.organization.sql} AND n.date BETWEEN ? AND ?`,
        params: [...homeParams, ...context.organization.params, context.range.startDate, context.range.endDate]
      },
      {
        query: `SELECT n.product_id, n.date FROM product_nights n ${home} WHERE n.organization_id = ${context.organization.sql} AND n.date BETWEEN ? AND ? AND n.closed = 1`,
        params: [...homeParams, ...context.organization.params, context.range.startDate, context.range.endDate]
      },
    ]
    return {
      queries,
      read(results: Row[][]): PageRead {
        const [homes, held, closed] = results
        // A home's night is open from the day it was listed, unless the calendar closed it.
        const booked = new Set(held!.map(row => `${row.product_id} ${row.date}`))
        const blocked = new Set(closed!.map(row => `${row.product_id} ${row.date}`).filter(key => !booked.has(key)))
        const nights = homes!.flatMap(row => context.dates
          .filter(date => date >= localDateAt(new Date(String(row.created_at)), context.reader.timezone))
          .map(date => ({ product_id: String(row.id), product_name: String(row.name), date, key: `${row.id} ${date}` })))
        const open = nights.filter(night => !blocked.has(night.key))
        const day = days(context.dates)
        const rate = (group: typeof nights) => percent(group.filter(night => booked.has(night.key)).length, group.filter(night => !blocked.has(night.key)).length)
        return {
          metrics: [
            { key: 'occupancy', label: 'Average occupancy rate', format: 'percent', value: rate(nights), daily: day.each(nights, night => night.date, rate) },
            { key: 'nights_booked', label: 'Nights booked', format: 'nights', value: open.filter(night => booked.has(night.key)).length, daily: day.sum(open, night => night.date, night => booked.has(night.key) ? 1 : 0) },
            { key: 'nights_blocked', label: 'Nights blocked', format: 'nights', value: nights.length - open.length, daily: day.sum(nights, night => night.date, night => blocked.has(night.key) ? 1 : 0) },
          ],
          list: {
            kind: 'rows', heading: 'Homes', columns: [{ label: 'Occupancy', format: 'percent' }, { label: 'Nights booked', format: 'nights' }],
            rows: byOffering(nights, group => [rate(group), group.filter(night => booked.has(night.key)).length])
          },
        }
      },
    }
  },

  'rates/bookings': (context) => {
    const queries: BatchQuery[] = [bookingsQuery(context, 'starts')]
    return {
      queries,
      read(results: Row[][]): PageRead {
        const [rows] = results
        const bookings = rows!.map(bookingRow).filter(inRange(context))
        const day = days(context.dates)
        const confirmed = (group: BookingRow[]) => group.filter(row => row.status === 'confirmed').length
        const title = pageTitle('rates/bookings', context.business.booked.filter(booked => booked !== 'stay'), context.kind)
        return {
          metrics: [
            { key: 'confirmed', label: title, format: 'count', value: confirmed(bookings), daily: day.each(bookings, startDay, confirmed) },
            { key: 'requested', label: 'Requested', format: 'count', value: bookings.length, daily: day.sum(bookings, startDay, () => 1) },
            { key: 'confirmed_share', label: 'Confirmed share', format: 'percent', value: percent(confirmed(bookings), bookings.length), daily: day.each(bookings, startDay, group => percent(confirmed(group), group.length)) },
          ],
          list: {
            kind: 'rows', heading: offeringsWord(context.business.booked, context.kind), columns: [{ label: 'Confirmed', format: 'count' }, { label: 'Requested', format: 'count' }],
            rows: byOffering(bookings, group => [confirmed(group), group.length])
          },
        }
      },
    }
  },

  'rates/cancellation-rate': (context) => {
    const queries: BatchQuery[] = [bookingsQuery(context, 'starts')]
    return {
      queries,
      read(results: Row[][]): PageRead {
        const [rows] = results
        const bookings = rows!.map(bookingRow).filter(inRange(context))
        const day = days(context.dates)
        const cancelled = (group: BookingRow[]) => group.filter(row => row.status === 'cancelled').length
        return {
          metrics: [
            { key: 'cancellation_rate', label: 'Cancellation rate', format: 'percent', value: percent(cancelled(bookings), bookings.length), daily: day.each(bookings, startDay, group => percent(cancelled(group), group.length)) },
            { key: 'cancelled', label: 'Cancelled', format: 'count', value: cancelled(bookings), daily: day.each(bookings, startDay, cancelled) },
            { key: 'bookings', label: 'Bookings', format: 'count', value: bookings.length, daily: day.sum(bookings, startDay, () => 1) },
          ],
          list: {
            kind: 'rows', heading: offeringsWord(context.business.booked, context.kind), columns: [{ label: 'Cancellation rate', format: 'percent' }, { label: 'Cancelled', format: 'count' }],
            rows: byOffering(bookings, group => [percent(cancelled(group), group.length), cancelled(group)])
          },
        }
      },
    }
  },

  'rates/length-of-stay': (context) => {
    const queries: BatchQuery[] = [bookingsQuery(context, 'starts', "AND b.status = 'confirmed'")]
    return {
      queries,
      read(results: Row[][]): PageRead {
        const [rows] = results
        const stays = rows!.map(bookingRow).filter(inRange(context))
        const day = days(context.dates)
        const mean = (group: BookingRow[]) => average(group.reduce((sum, row) => sum + nightsOf(row), 0), group.length)
        const longest = (group: BookingRow[]) => group.length ? Math.max(...group.map(nightsOf)) : null
        return {
          metrics: [
            { key: 'average_nights', label: 'Average length of stay', format: 'nights', value: mean(stays), daily: day.each(stays, startDay, mean) },
            { key: 'longest', label: 'Longest stay', format: 'nights', value: longest(stays), daily: day.each(stays, startDay, longest) },
          ],
          list: {
            kind: 'rows', heading: 'Homes', columns: [{ label: 'Average length of stay', format: 'nights' }, { label: 'Stays', format: 'count' }],
            rows: byOffering(stays, group => [mean(group), group.length])
          },
        }
      },
    }
  },

  'rates/party-size': (context) => {
    const queries: BatchQuery[] = [bookingsQuery(context, 'starts', "AND b.status = 'confirmed'")]
    return {
      queries,
      read(results: Row[][]): PageRead {
        const [rows] = results
        const bookings = rows!.map(bookingRow).filter(inRange(context))
        const day = days(context.dates)
        const mean = (group: BookingRow[]) => average(group.reduce((sum, row) => sum + row.party_size, 0), group.length)
        const largest = (group: BookingRow[]) => group.length ? Math.max(...group.map(row => row.party_size)) : null
        return {
          metrics: [
            { key: 'average_party', label: 'Average party size', format: 'people', value: mean(bookings), daily: day.each(bookings, startDay, mean) },
            { key: 'largest_party', label: 'Largest party', format: 'people', value: largest(bookings), daily: day.each(bookings, startDay, largest) },
          ],
          list: {
            kind: 'rows', heading: offeringsWord(context.business.booked, context.kind), columns: [{ label: 'Average party size', format: 'people' }, { label: 'Bookings', format: 'count' }],
            rows: byOffering(bookings, group => [mean(group), group.length])
          },
        }
      },
    }
  },

  'rates/nightly-rate': (context) => {
    const queries: BatchQuery[] = [bookingsQuery(context, 'starts', "AND b.status = 'confirmed'")]
    return {
      queries,
      read(results: Row[][]): PageRead {
        const [rows] = results
        const stays = rows!.map(bookingRow).filter(inRange(context))
        const day = days(context.dates)
        const income = (group: BookingRow[]) => group.reduce((sum, row) => sum + row.total_minor!, 0)
        const nightly = (group: BookingRow[]) => average(income(group), group.reduce((sum, row) => sum + nightsOf(row), 0), 0)
        return {
          currency: insightsCurrency(stays.map(row => row.currency!), context.reader.defaultCurrency),
          metrics: [
            { key: 'nightly_rate', label: 'Average nightly rate', format: 'money', value: nightly(stays), daily: day.each(stays, startDay, nightly) },
            { key: 'income', label: 'Booking value', format: 'money', value: income(stays), daily: day.each(stays, startDay, income) },
          ],
          list: {
            kind: 'rows', heading: 'Homes', columns: [{ label: 'Average nightly rate', format: 'money' }, { label: 'Booking value', format: 'money' }],
            rows: byOffering(stays, group => [nightly(group), income(group)])
          },
        }
      },
    }
  },

  'rates/average-value': (context) => {
    const prepared = bookingsWithIncome(context);
    return {
      queries: prepared.queries, read(results: Row[][]): PageRead {
        const { bookings } = prepared.read(results)
        const received = (row: typeof bookings[number]) => (row.online_amount ?? 0) + (row.offline_amount ?? 0)
        const income = (group: typeof bookings) => group.reduce((sum, row) => sum + received(row), 0)
        const value = (group: typeof bookings) => average(income(group), group.filter(row => received(row) > 0).length, 0)
        const day = days(context.dates)
        return {
          currency: insightsCurrency(bookings.flatMap(row => row.currencies), context.reader.defaultCurrency),
          metrics: [
            { key: 'average_value', label: 'Average booking value', format: 'money', value: value(bookings), daily: day.each(bookings, startDay, value) },
            { key: 'income', label: 'Booking income', format: 'money', value: income(bookings), daily: day.each(bookings, startDay, income) },
          ],
          list: {
            kind: 'rows', heading: offeringsWord(context.business.booked, context.kind), columns: [{ label: 'Average booking value', format: 'money' }, { label: 'Booking income', format: 'money' }],
            rows: byOffering(bookings, group => [value(group), income(group)])
          },
        }

      }
    }
  },

  'rates/income-by-channel': (context) => {
    // An order is paid through Stripe like a booking but books no kind, so it counts as Direct, on the day it was paid, only with every kind shown.
    const orders: BatchQuery[] = context.kind === 'all' ? [{
      query: `SELECT o.paid_at, p.currency, p.captured_amount - p.refunded_amount AS amount, p.refunded_amount AS refunded
        FROM orders o JOIN payments p ON p.organization_id = o.organization_id AND p.subject_type = 'order' AND p.subject_id = o.id
        WHERE o.organization_id = ${context.organization.sql} AND o.paid_at >= ? AND o.paid_at < ? ${context.locationId ? 'AND o.location_id = ?' : ''}`,
      params: [...context.organization.params, context.window.from, context.window.until, ...(context.locationId ? [context.locationId] : [])],
    }] : []
    const prepared = bookingsWithIncome(context, orders);
    return {
      queries: prepared.queries, read(results: Row[][]): PageRead {
        const { bookings, also: [paidOrders] } = prepared.read(results)
        const paid = (paidOrders ?? []).filter(row => context.dates.includes(localDateAt(new Date(String(row.paid_at)), context.reader.timezone)))
        const amounts = paid.map(row => ({ channel: 'Direct', day: localDateAt(new Date(String(row.paid_at)), context.reader.timezone), amount: num(row.amount), refunded: num(row.refunded) }))
          .concat(bookings.flatMap(row => {
            const day = startDay(row)
            return [
              ...(row.online_amount === null ? [] : [{ channel: 'Direct', day, amount: row.online_amount, refunded: row.online_refunded }]),
              ...(row.offline_amount === null ? [] : [{ channel: 'Recorded by you', day, amount: row.offline_amount, refunded: row.offline_refunded }]),
              ...(row.owner === 'channel' && row.status === 'confirmed' && row.total_minor !== null
                ? [{ channel: CHANNEL_LABELS[row.channel] ?? row.channel, day, amount: row.total_minor, refunded: 0 }] : []),
            ]
          }))
        const day = days(context.dates)
        const total = (group: typeof amounts) => group.reduce((sum, row) => sum + row.amount, 0)
        const direct = amounts.filter(row => row.channel === 'Direct')
        const order = ['Direct', 'Recorded by you', ...Object.values(CHANNEL_LABELS)]
        return {
          currency: insightsCurrency([...bookings.flatMap(row => [...row.currencies, ...row.owner === 'channel' && row.status === 'confirmed' && row.total_minor !== null ? [row.currency!] : []]), ...paid.map(row => String(row.currency))], context.reader.defaultCurrency),
          metrics: [
            { key: 'income', label: 'Income', format: 'money', value: total(amounts), daily: day.sum(amounts, row => row.day, row => row.amount) },
            { key: 'direct', label: 'Direct', format: 'money', value: total(direct), daily: day.sum(direct, row => row.day, row => row.amount) },
            { key: 'refunded', label: 'Refunded', format: 'money', value: amounts.reduce((sum, row) => sum + row.refunded, 0), daily: day.sum(amounts, row => row.day, row => row.refunded) },
          ],
          list: {
            kind: 'rows', heading: 'Channel', columns: [{ label: 'Income', format: 'money' }],
            rows: order.filter(channel => amounts.some(row => row.channel === channel)).map(channel => ({ key: channel, label: channel, values: [total(amounts.filter(row => row.channel === channel))] }))
          },
        }

      }
    }
  },

  'conversion/booking-conversion': (context) => {
    const kinds = pageKinds(context.definition, context.kind)
    const queries: BatchQuery[] = [
      // An offering's views are counted on its own page; a dish is not an offering here.
      {
        query: `SELECT s.date, (s.key ->> '$[1]') AS product_id, p.name AS product_name, CAST(s.payload_json ->> '$.page_views' AS INTEGER) AS views
          FROM analytics_summaries s JOIN products p ON p.organization_id = s.organization_id AND p.id = (s.key ->> '$[1]')
          WHERE s.organization_id = ${context.organization.sql} AND s.kind = 'dimension_day' AND s.date BETWEEN ? AND ? AND (s.key ->> '$[0]') = 'product' AND p.kind IN (SELECT value FROM json_each(?))`,
        params: [...context.organization.params, context.range.startDate, context.range.endDate, JSON.stringify(kinds)]
      },
      bookingsQuery(context, 'received', 'AND b.website_source IS NOT NULL'),
      // The clicks counted on their own write (server/utils/organization-conversions.ts), beside the business's vertical.
      {
        query: `SELECT o.vertical, s.date, s.key, CAST(s.payload_json ->> '$.page_views' AS INTEGER) AS clicks FROM organization o
          LEFT JOIN analytics_summaries s ON s.organization_id = o.id AND s.kind = 'dimension_day' AND s.date BETWEEN ? AND ? AND s.key IN (SELECT value FROM json_each(?))
          WHERE o.id = ${context.organization.sql}`,
        params: [context.range.startDate, context.range.endDate, JSON.stringify([...new Set(INSIGHTS_CLICKS.flatMap(click => click.events.map(clickKey)))]), ...context.organization.params]
      },
    ]
    return {
      queries,
      read(results: Row[][]): PageRead {
        const [views, rows, clicked] = results
        const vertical = String(clicked![0]!.vertical)
        // Clicks are not about one kind of booking: they are counted under All.
        const clicks = context.kind === 'all' ? INSIGHTS_CLICKS.filter(click => !click.verticals || (click.verticals as readonly string[]).includes(vertical)) : []
        const viewed = views!.filter(row => context.dates.includes(String(row.date))).map(row => ({ date: String(row.date), product_id: String(row.product_id), product_name: String(row.product_name), views: num(row.views), bookings: 0 }))
        const made = rows!.map(bookingRow).filter(row => context.dates.includes(receivedDay(context)(row))).map(row => ({ date: receivedDay(context)(row), product_id: row.product_id, product_name: row.product_name, views: 0, bookings: 1 }))
        const all = [...viewed, ...made]
        const sum = (group: typeof all, field: 'views' | 'bookings') => group.reduce((total, row) => total + row[field], 0)
        const day = days(context.dates)
        const offering = singular(offeringsWord(context.business.booked, context.kind))
        return {
          metrics: [
            { key: 'conversion', label: 'Booking conversion', format: 'percent', value: percent(sum(all, 'bookings'), sum(all, 'views')), daily: day.each(all, row => row.date, group => percent(sum(group, 'bookings'), sum(group, 'views'))) },
            { key: 'views', label: `${offering} page views`, format: 'count', value: sum(all, 'views'), daily: day.sum(all, row => row.date, row => row.views) },
            { key: 'bookings', label: 'Bookings', format: 'count', value: sum(all, 'bookings'), daily: day.sum(all, row => row.date, row => row.bookings) },
            ...clicks.map((click): Metric => {
              const keys = click.events.map(clickKey)
              const daily = day.sum(clicked!.filter(row => keys.includes(String(row.key))), row => String(row.date), row => num(row.clicks))
              return { key: click.key, label: click.label, format: 'count', value: daily.reduce((total, count) => total + count, 0), daily }
            }),
          ],
          list: {
            kind: 'rows', heading: offeringsWord(context.business.booked, context.kind), columns: [{ label: 'Booking conversion', format: 'percent' }, { label: 'Page views', format: 'count' }, { label: 'Bookings', format: 'count' }],
            rows: byOffering(all, group => [percent(sum(group, 'bookings'), sum(group, 'views')), sum(group, 'views'), sum(group, 'bookings')])
          },
        }
      },
    }
  },

  'conversion/lead-time': (context) => {
    const queries: BatchQuery[] = [bookingsQuery(context, 'received', 'AND b.website_source IS NOT NULL')]
    return {
      queries,
      read(results: Row[][]): PageRead {
        const [rows] = results
        const bookings = rows!.map(bookingRow).filter(row => context.dates.includes(receivedDay(context)(row)))
        // From the day the guest booked to the day the booking starts, both in the booking's own clock.
        const lead = (row: BookingRow) => dayDiff(localDateAt(new Date(row.created_at), row.timezone), startDay(row))
        const mean = (group: BookingRow[]) => average(group.reduce((sum, row) => sum + lead(row), 0), group.length)
        const soon = (group: BookingRow[]) => percent(group.filter(row => lead(row) < 3).length, group.length)
        const day = days(context.dates)
        return {
          subtitle: 'Website bookings',
          metrics: [
            { key: 'average_lead', label: 'Average lead time', format: 'days', value: mean(bookings), daily: day.each(bookings, receivedDay(context), mean) },
            { key: 'within_3_days', label: 'Booked within 3 days', format: 'percent', value: soon(bookings), daily: day.each(bookings, receivedDay(context), soon) },
          ],
          list: {
            kind: 'rows', heading: offeringsWord(context.business.booked, context.kind), columns: [{ label: 'Average lead time', format: 'days' }, { label: 'Bookings', format: 'count' }],
            rows: byOffering(bookings, group => [mean(group), group.length])
          },
        }
      },
    }
  },

  'conversion/returning': (context) => {
    const queries: BatchQuery[] = [bookingsQuery(context, 'received', 'AND b.website_source IS NOT NULL')]
    return {
      queries,
      read(results: Row[][]): PageRead {
        const [rows] = results
        const bookings = rows!.map(bookingRow).filter(row => context.dates.includes(receivedDay(context)(row)))
        const returning = (group: BookingRow[]) => group.filter(row => row.returning === 1).length
        const day = days(context.dates)
        const people = bookerWord(context.business.booked, context.kind)
        return {
          subtitle: 'Website bookings',
          metrics: [
            { key: 'returning_share', label: `Returning ${people}`, format: 'percent', value: percent(returning(bookings), bookings.length), daily: day.each(bookings, receivedDay(context), group => percent(returning(group), group.length)) },
            { key: 'returning', label: 'Bookings by returning ' + people, format: 'count', value: returning(bookings), daily: day.each(bookings, receivedDay(context), returning) },
          ],
          list: {
            kind: 'rows', heading: offeringsWord(context.business.booked, context.kind), columns: [{ label: `Returning ${people}`, format: 'percent' }, { label: 'Bookings', format: 'count' }],
            rows: byOffering(bookings, group => [percent(returning(group), group.length), group.length])
          },
        }
      },
    }
  },

  'conversion/page-views': (context) => {
    const { range } = context
    const queries: BatchQuery[] = [
      {
        query: `SELECT date, CAST(payload_json ->> '$.page_views' AS INTEGER) AS views FROM analytics_summaries WHERE organization_id = ${context.organization.sql} AND kind = 'organization_day' AND key = '' AND date BETWEEN ? AND ?`,
        params: [...context.organization.params, range.startDate, range.endDate]
      },
      {
        query: `SELECT date, SUM(CAST(payload_json ->> '$.page_views' AS INTEGER)) AS views FROM analytics_summaries WHERE organization_id = ${context.organization.sql} AND kind = 'organization_day' AND key = '' AND date BETWEEN ? AND ? GROUP BY date`,
        params: [...context.organization.params, range.previousStartDate, range.previousEndDate]
      },
    ]
    return {
      queries,
      read(results: Row[][]): PageRead {
        const [current, previous] = results
        const day = days(context.dates)
        const daily = day.sum(current!, row => String(row.date), row => num(row.views))
        const total = daily.reduce((sum, views) => sum + views, 0)
        const before = previous!.filter(row => String(row.date) >= context.range.previousStartDate && String(row.date) <= context.range.previousEndDate).reduce((sum, row) => sum + num(row.views), 0)
        return {
          metrics: [
            { key: 'page_views', label: 'Page views', format: 'count', value: total, daily },
            { key: 'change', label: 'Change', format: 'percent', value: before ? Math.round((total - before) / before * 1000) / 10 : null },
          ],
          list: {
            kind: 'rows', heading: 'Day', columns: [{ label: 'Page views', format: 'count' }],
            rows: context.dates.map((date, index) => ({ key: date, label: formatCalendarDate(date, 'en'), values: [daily[index]!] })).reverse()
          },
        }
      },
    }
  },

  'conversion/top-pages': (context) => {
    const queries: BatchQuery[] = [{
      query: `SELECT key, date, CAST(payload_json ->> '$.page_views' AS INTEGER) AS views
      FROM analytics_summaries WHERE organization_id = ${context.organization.sql} AND kind = 'page_day' AND date BETWEEN ? AND ?`,
      params: [...context.organization.params, context.range.startDate, context.range.endDate]
    }]
    return {
      queries, read([rows]: Row[][]): PageRead {
        const current = rows!.filter(row => context.dates.includes(String(row.date)) && num(row.views) > 0)
        const totals = new Map<string, number>()
        for (const row of current) totals.set(String(row.key), (totals.get(String(row.key)) ?? 0) + num(row.views))
        const pages = [...totals].map(([key, views]) => ({ key, views })).sort((a, b) => b.views - a.views || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        const day = days(context.dates)
        const total = pages.reduce((sum, page) => sum + page.views, 0), top = pages[0]
        return {
          metrics: [
            { key: 'page_views', label: 'Page views', format: 'count', value: total, daily: day.sum(current, row => String(row.date), row => num(row.views)) },
            { key: 'pages_viewed', label: 'Pages viewed', format: 'count', value: pages.length, daily: day.sum(current, row => String(row.date), () => 1) },
            { key: 'most_viewed', label: 'Most viewed', format: 'text', value: top?.views ?? null, text: top?.key ?? null },
          ],
          list: { kind: 'rows', heading: 'Page', columns: [{ label: 'Page views', format: 'count' }], rows: pages.slice(0, 100).map(page => ({ key: page.key, label: page.key, values: [page.views] })) },
        }
      }
    }
  },

  'conversion/sources': (context) => {
    const { range } = context
    const queries: BatchQuery[] = [
      {
        query: `SELECT date, (key ->> '$[1]') AS source, CAST(payload_json ->> '$.page_views' AS INTEGER) AS visits FROM analytics_summaries
          WHERE organization_id = ${context.organization.sql} AND kind = 'dimension_day' AND date BETWEEN ? AND ? AND (key ->> '$[0]') = 'visit_source'`,
        params: [...context.organization.params, range.startDate, range.endDate]
      },
      bookingsQuery(context, 'received', 'AND b.website_source IS NOT NULL'),
    ]
    return {
      queries,
      read(results: Row[][]): PageRead {
        const [visits, rows] = results
        // Where website visitors came from, and the bookings those visits made. A booking with no recorded visit is not a website booking here.
        const facts = [
          ...visits!.map(row => ({ date: String(row.date), source: String(row.source), visits: num(row.visits), bookings: 0, website: false })),
          ...rows!.map(bookingRow).map(row => ({ date: receivedDay(context)(row), source: row.website_source!, visits: 0, bookings: 1, website: true })),
        ].filter(row => context.dates.includes(row.date))
        const day = days(context.dates)
        const sum = (group: typeof facts, field: 'visits' | 'bookings') => group.reduce((total, row) => total + row[field], 0)
        const website = facts.filter(row => row.website && row.bookings)
        const search = website.filter(row => row.source === 'Organic search')
        const order: string[] = [...ATTRIBUTION_CHANNELS]
        const sources = [...new Set(facts.map(row => row.source))].sort((a, b) => (order.indexOf(a) + 1 || order.length + 1) - (order.indexOf(b) + 1 || order.length + 1) || a.localeCompare(b))
        return {
          metrics: [
            { key: 'visits', label: 'Visits', format: 'count', value: sum(facts, 'visits'), daily: day.sum(facts, row => row.date, row => row.visits) },
            { key: 'website_bookings', label: 'Bookings from your website', format: 'count', value: website.length, daily: day.sum(website, row => row.date, () => 1) },
            { key: 'search_bookings', label: 'Bookings from search', format: 'count', value: search.length, daily: day.sum(search, row => row.date, () => 1) },
          ],
          list: {
            kind: 'rows', heading: 'Source', columns: [{ label: 'Visits', format: 'count' }, { label: 'Bookings', format: 'count' }],
            rows: sources.map(source => { const group = facts.filter(row => row.source === source); return { key: source, label: source, values: [sum(group, 'visits'), sum(group, 'bookings')] } })
              .filter(row => row.values.some(value => value))
          },
        }
      },
    }
  },
}

/** The Marketing pages, read from the provider as they open; a page that cannot be read says why and where to fix it. */
const MARKETING_READS: Record<'marketing/instagram' | 'marketing/google-ads', (env: CloudflareEnv, context: PageContext) => Promise<PageRead>> = {
  'marketing/instagram': async (env, context) => {
    const page = await loadInstagramInsights(env, context.reader.organizationId, { startDate: context.range.startDate, endDate: context.range.endDate })
    if (page.status !== 'connected') return { metrics: [], list: null, note: page.message, action: { label: 'Instagram settings', to: `/dashboard/${context.reader.slug}/integrations/instagram` } }
    return {
      note: `@${page.username} · Instagram reports its numbers up to 48 hours late.`,
      metrics: [
        {
          key: 'posts', label: 'Posts published', format: 'count', value: page.media.length,
          daily: days(context.dates).sum(page.media, post => localDateAt(new Date(post.postedAt), page.period.timezone), () => 1)
        },
        { key: 'reach', label: 'Accounts reached', format: 'count', value: page.account.reach },
        { key: 'views', label: 'Views', format: 'count', value: page.account.views },
      ],
      list: {
        kind: 'rows', heading: 'Post', columns: [{ label: 'Views', format: 'count' }, { label: 'Reach', format: 'count' }],
        rows: page.media.map(post => ({ key: post.id, label: post.caption || 'Untitled post', values: [post.insights?.views ?? null, post.insights?.reach ?? null] }))
      },
    }
  },
  'marketing/google-ads': async (env, context) => {
    const page = await loadGoogleAdsInsights(env, context.reader.organizationId, { startDate: context.range.startDate, endDate: context.range.endDate })
    if (page.status !== 'connected') return { metrics: [], list: null, note: page.message, action: { label: 'Google Ads settings', to: `/dashboard/${context.reader.slug}/integrations/google-ads` } }
    const day = (field: 'costMicros' | 'clicks' | 'conversions') => context.dates.map(date => page.days.find(entry => entry.date === date)?.[field] ?? 0)
    return {
      currency: page.customer.currency,
      note: `${page.customer.name} · Spend is as Google Ads reports it.`,
      metrics: [
        { key: 'spend', label: 'Spend', format: 'micros', value: page.totals.costMicros, daily: day('costMicros') },
        { key: 'clicks', label: 'Clicks', format: 'count', value: page.totals.clicks, daily: day('clicks') },
        { key: 'conversions', label: 'Conversions', format: 'count', value: page.totals.conversions, daily: day('conversions') },
      ],
      list: {
        kind: 'rows', heading: 'Campaign', columns: [{ label: 'Spend', format: 'micros' }, { label: 'Clicks', format: 'count' }],
        rows: page.campaigns.map(campaign => ({ key: campaign.id, label: campaign.name, values: [campaign.costMicros, campaign.clicks] }))
      },
    }
  },
}
