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
 const activeOnly = getQuery(event).onboarding_status === 'active'
 const calendar = prepareCalendarCapabilities({ query: 'o.id', params: [] }, { sql: 'm.userId' })
 const queries = (user: BatchQuery): BatchQuery[] => {
   const owners = { sql: `SELECT o.id FROM member m JOIN organization o ON o.id=m.organizationId WHERE m.userId=${user.query} AND (? = 0 OR o.onboarding_status = ?)`, params: [...user.params ?? [], Number(activeOnly), 'active'] }
   return [{ query: `SELECT o.id,o.slug,o.name,o.vertical,o.default_currency,m.role, (${calendar.query.query}) AS calendar_json FROM member m JOIN organization o ON o.id=m.organizationId WHERE m.userId=${user.query} AND (? = 0 OR o.onboarding_status = ?) ORDER BY o.name`, params: [...calendar.query.params ?? [], ...owners.params] },
     mediaPlacementsQuery({ organizationId: { sql: 'mp.owner_id' }, ownerType: 'organization', owners, slot: 'logo' })]
 }
 const document: DashboardAuthRead = { queries: token => queries(dashboardSessionUserQuery(token)) }
 const session=await getAuthSession(event,env,{document})
 if(!session)throw new HTTPError({statusCode:401,statusMessage:'Sign in to view your organizations'})
 const [members, media] = document.results ?? await executeBatch(env.DB, queries({query:'?',params:[session.user.id]}), { operation: 'Read account workspaces' })
 const rows = members!.results as Array<{id:string;slug:string;name:string;vertical:string;default_currency:string;role:string;calendar_json:string}>
 const logos = groupMediaPlacements(media!.results)
 const organizations=await rows.map(({calendar_json,...row})=>{
   const roles = row.role.split(',').map(value => value.trim())
   const catalog_access = roles.some(role => productRoles.has(role)) ? 'products' : roles.some(role => kitchenRoles.has(role)) ? 'menu' : 'none'
   return { ...row, catalog_access, operations_access: roles.some(role => operationsRoles.has(role)), calendar: calendar.decode(calendar_json), image_url: mediaStillUrl(logos.get(row.id)?.[0]) ?? null }
 })
 return jsonResponse({organizations},{headers:{'cache-control':'private, no-store'}})
})
