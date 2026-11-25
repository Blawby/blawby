import { E2E_ADMIN_ID } from '../../../../config/development-auth-fixtures.ts'
import type { CreateTenant } from '../seed.ts'
import { SEED_SUBDOMAINS, type SeedTenant } from '../manifest.ts'
import { alwaysOpen, recordProduct, seedLocation, toolFor } from './common.ts'

/** Sixteen homes exercise Calendar scrolling beyond its first twelve virtual rows. */
export async function seedLodging(createTenant: CreateTenant): Promise<SeedTenant> {
  const { owner, tenant, location_id } = await createTenant({
    key: 'lodging', name: 'Cove Cabins', slug: 'cove-cabins', subdomain: SEED_SUBDOMAINS.lodging,
    vertical: 'lodging', currency: 'THB', timezone: 'Asia/Bangkok', subscription: null,
  })
  try {
    const tool = toolFor(owner, tenant)
    const location = await seedLocation(tool, tenant, 'cove', {
      title: 'Cove Cabins', email: 'host@cove-cabins.example', phone: '+61491570006', hours: alwaysOpen(),
      address: { regionCode: 'TH', addressLines: ['16 Cove Road'], locality: 'Krabi', administrativeArea: 'Krabi', postalCode: '81000' },
    }, location_id)
    const memberId = tenant.memberIds[E2E_ADMIN_ID]
    if (!memberId) throw new Error('The Cove Cabins owner is not a member')
    for (let number = 1; number <= 16; number++) {
      const key = `cabin-${String(number).padStart(2, '0')}`
      const { product } = await tool<{ product: { id: string; slug: string; name: string; kind: string } }>('create_product', {
        kind: 'stay', name: `Cove Cabin ${String(number).padStart(2, '0')}`, active: true, idempotency_key: `seed-${key}`,
        stay: { internal_name: `Cabin ${String(number).padStart(2, '0')}`, location_id: location.id, assigned_member_id: memberId,
          check_in_time: '15:00', check_out_time: '11:00', max_guests: 4, min_nights: 1 },
      })
      recordProduct(tenant, key, product)
    }
    return tenant
  } finally { await owner.dispose() }
}
