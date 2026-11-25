import { HTTPError } from 'nitro'
import { d1JsonStringSet, executeBatch, type DbClient } from '~/server/db'
import { requireManager, visibleHomes, type StayAccess } from '~/server/domain/stays'
import { homeCleanersSql, jobAssigneeSql, rehomeTurnoversQuery } from '~/server/domain/tasks'
import { changedTaskIds, publishChangedJobs, type EventsEnv } from '~/server/events'
import { roleMatchesSql, type StoredListingAccess } from '~/utils/organization-access'

/*
  Who cleans a home (#2091 sections 7b and 8). The home's team
  (listing_message_members) already says who works on it; its cleaners are the
  members with the cleaner role and task access, first first. A new clean goes
  to the first, or, when the home offers its cleans to all its cleaners, is held
  by its host until one accepts. With no cleaner it goes to the host
  (product_booking_configs.assigned_member_id), who is the person guests see.
*/

export interface HomeTeamMember {
  member_id: string
  name: string
  role: string
  access: StoredListingAccess
  /** Is one of the home's cleaners: the cleaner role with task access. */
  cleaner: boolean
}

export interface HomeTeam {
  product_id: string
  /** Who guests see and who holds a clean nobody else can take. */
  host: { member_id: string; name: string }
  members: HomeTeamMember[]
  /** The home's cleaners, first first: a new clean goes to the first, a declined one to the next. */
  cleaner_ids: string[]
  /** Each clean is offered to all the cleaners and the first to accept takes it. */
  offer_cleans_to_all: boolean
}

function fail(statusCode: number, code: string, message: string, field?: string): never {
  throw new HTTPError({ statusCode, message, data: { code, ...(field ? { field } : {}) } })
}

/** A home's team and who cleans it, for the people who can see the home. */
export async function readHomeTeam(db: DbClient, access: StayAccess, productId: string): Promise<HomeTeam> {
  const scope = visibleHomes(access)
  const [homeRows, memberRows, cleanerRows] = (await executeBatch(db, [{
    query: `SELECT c.product_id, c.offer_cleans_to_all, host.id AS host_id, hu.name AS host_name FROM product_stay_configs c
      JOIN product_booking_configs b ON b.organization_id = c.organization_id AND b.product_id = c.product_id
      JOIN member host ON host.id = ${jobAssigneeSql('c.organization_id', 'b.assigned_member_id')} JOIN user hu ON hu.id = host.userId
      WHERE c.organization_id = ? AND c.product_id = ? AND ${scope.sql}`,
    params: [access.organizationId, productId, ...scope.params],
  }, {
    query: `SELECT g.member_id, u.name, m.role, g.access, g.access IN ('tasks', 'operations') AND ${roleMatchesSql('m.role', ['cleaner'])} AS cleaner
      FROM listing_message_members g JOIN member m ON m.id = g.member_id AND m.organizationId = g.organization_id JOIN user u ON u.id = m.userId
      WHERE g.organization_id = ? AND g.listing_id = ? ORDER BY u.name, g.member_id`,
    params: [access.organizationId, productId],
  }, { query: homeCleanersSql('?', '?'), params: [access.organizationId, productId] }], { operation: 'Read home team' }))
    .map(result => result.results)
  const home = homeRows![0] as { product_id: string; offer_cleans_to_all: number; host_id: string; host_name: string } | undefined
  if (!home) fail(404, 'HOME_NOT_FOUND', 'That place to stay is not in this organization')
  return {
    product_id: home.product_id, host: { member_id: home.host_id, name: home.host_name },
    members: (memberRows as Array<Omit<HomeTeamMember, 'cleaner'> & { cleaner: number }>).map(row => ({ ...row, cleaner: row.cleaner === 1 })),
    cleaner_ids: (cleanerRows as Array<{ member_id: string }>).map(row => row.member_id),
    offer_cleans_to_all: home.offer_cleans_to_all === 1,
  }
}

/**
 * Set the order of a home's cleaners (all of them, first first) and whether it offers its cleans
 * to all of them. The home's open cleans that have not started go to whoever cleans it now.
 * Owners and admins.
 */
export async function setHomeCleaning(db: DbClient, env: EventsEnv, access: StayAccess, productId: string, body: Record<string, unknown>): Promise<HomeTeam> {
  requireManager(access)
  const unknown = Object.keys(body).find(key => key !== 'cleaner_ids' && key !== 'offer_cleans_to_all')
  if (unknown) fail(422, 'INVALID_HOME_CLEANING', `${unknown} is not part of a home's cleaning`, unknown)
  if (body.offer_cleans_to_all !== undefined && typeof body.offer_cleans_to_all !== 'boolean') fail(422, 'INVALID_HOME_CLEANING', 'offer_cleans_to_all must be true or false', 'offer_cleans_to_all')
  const team = await readHomeTeam(db, access, productId)
  const order = body.cleaner_ids
  if (order !== undefined) {
    if (!Array.isArray(order) || order.some(id => typeof id !== 'string') || new Set(order).size !== order.length
      || order.length !== team.cleaner_ids.length || order.some(id => !team.cleaner_ids.includes(id as string))) {
      fail(422, 'INVALID_HOME_CLEANING', `cleaner_ids must list each of the home's cleaners once: ${team.cleaner_ids.join(', ') || 'it has none'}. Add a cleaner to the home's team first.`, 'cleaner_ids')
    }
  }
  const now = new Date().toISOString()
  const results = await executeBatch(db, [
    ...(order !== undefined ? [{
      query: `UPDATE listing_message_members SET cleaning_order = (SELECT ordered.key FROM json_each(?) ordered WHERE ordered.value = listing_message_members.member_id)
        WHERE organization_id = ? AND listing_id = ? AND member_id IN (SELECT value FROM json_each(?))`,
      params: [JSON.stringify(order), access.organizationId, productId, d1JsonStringSet(order as string[])],
    }] : []),
    ...(body.offer_cleans_to_all !== undefined ? [{
      query: 'UPDATE product_stay_configs SET offer_cleans_to_all = ?, updated_at = ?, updated_by = ? WHERE organization_id = ? AND product_id = ?',
      params: [body.offer_cleans_to_all ? 1 : 0, now, access.actorId, access.organizationId, productId],
    }] : []),
    rehomeTurnoversQuery(access.organizationId, productId, now),
  ], { operation: 'Set home cleaning' })
  await publishChangedJobs(env, access.organizationId, changedTaskIds(results))
  return readHomeTeam(db, access, productId)
}
