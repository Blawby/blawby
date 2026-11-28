import { prepareActiveOnboardingDraft } from '~/server/utils/onboarding-drafts'
import { WEBSITE_ONBOARDING_CREATE_ACTION, WEBSITE_ONBOARDING_RESUME_ACTION } from '~/shared/onboarding-flow'
import { roleAllows } from '~/server/utils/member-access'
import { rolesAllowing, workspaceOperationsRoles } from '~/utils/organization-access'
import {defineHandler,HTTPError} from 'nitro'
import {getQuery} from 'nitro/h3'
import {cloudflareEnv,jsonResponse} from '~/server/utils/api-response'
import {getAuthSession, dashboardSessionUserQuery, type DashboardAuthRead} from '~/server/utils/auth'
import {executeBatch, type BatchQuery} from '~/server/db'
import { mediaPlacementsQuery, groupMediaPlacements } from '~/server/utils/media-asset-manager'
import { mediaStillUrl } from '~/shared/media-placement-contract'
import { prepareCalendarCapabilities } from '~/server/utils/dashboard-context-service'
const productRoles = new Set<string>([...rolesAllowing({ products: ['read'] }), ...rolesAllowing({ products: ['assigned'] })])
const kitchenRoles = new Set<string>(rolesAllowing({ menu: ['read'] }))
const operationsRoles = new Set<string>(workspaceOperationsRoles)
/** The organizations this account belongs to, each with its mark, vertical, default currency and this account's role: the Organizations list under Account settings and the iOS workspace switcher. */
export default defineHandler(async event=>{
 const env=cloudflareEnv(event)
 const query = getQuery(event)
 const screen = query.view === 'workspaces'
 if (query.view !== undefined && !screen) throw new HTTPError({statusCode:400,message:'Choose a valid workspace view',data:{code:'INVALID_QUERY',field:'view'}})
 const activeOnly = query.onboarding_status === 'active'
 let draft: ReturnType<typeof prepareActiveOnboardingDraft> | undefined
 const calendar = prepareCalendarCapabilities({ query: 'o.id', params: [] }, { sql: 'm.userId' })
 const queries = (user: BatchQuery): BatchQuery[] => {
   draft = screen ? prepareActiveOnboardingDraft(user) : undefined
   const owners = { sql: `SELECT o.id FROM member m JOIN organization o ON o.id=m.organizationId WHERE m.userId=${user.query} AND (? = 0 OR o.onboarding_status = ?)`, params: [...user.params ?? [], Number(activeOnly), 'active'] }
   return [{ query: `SELECT o.id,o.slug,o.name,o.vertical,o.default_currency,m.role, (${calendar.query.query}) AS calendar_json FROM member m JOIN organization o ON o.id=m.organizationId WHERE m.userId=${user.query} AND (? = 0 OR o.onboarding_status = ?) ORDER BY o.name`, params: [...calendar.query.params ?? [], ...owners.params] },
     mediaPlacementsQuery({ organizationId: { sql: 'mp.owner_id' }, ownerType: 'organization', owners, slot: 'logo' }), ...(draft ? [draft.query] : [])]
 }
 const document: DashboardAuthRead = { queries: token => queries(dashboardSessionUserQuery(token)) }
 const session=await getAuthSession(event,env,{document,forwardCookies:true})
 if(!session)throw new HTTPError({statusCode:401,statusMessage:'Sign in to view your organizations'})
 const [members, media, draftRows] = document.results ?? await executeBatch(env.DB, queries({query:'?',params:[session.user.id]}), { operation: 'Read account workspaces' })
 const rows = members!.results as Array<{id:string;slug:string;name:string;vertical:string;default_currency:string;role:string;calendar_json:string}>
 const logos = groupMediaPlacements(media!.results)
 const organizations=await Promise.all(rows.map(async ({calendar_json,...row})=>{
   const roles = row.role.split(',').map(value => value.trim())
   const catalog_access = roles.some(role => productRoles.has(role)) ? 'products' : roles.some(role => kitchenRoles.has(role)) ? 'menu' : 'none'
   return { ...row, catalog_access, operations_access: roles.some(role => operationsRoles.has(role)), ...(screen ? { can_delete: await roleAllows({organizationId:row.id,role:row.role,permissions:{organization:['delete']}}) } : {}), calendar: calendar.decode(calendar_json), image_url: mediaStillUrl(logos.get(row.id)?.[0]) ?? null }
 }))
 const website_setup_action = screen ? draft!.read(draftRows!) ? {...WEBSITE_ONBOARDING_RESUME_ACTION,kind:'resume' as const} : {...WEBSITE_ONBOARDING_CREATE_ACTION,kind:'create' as const} : undefined
 return jsonResponse({organizations,...(screen ? {website_setup_action} : {})},{headers:{'cache-control':'private, no-store'}})
})
