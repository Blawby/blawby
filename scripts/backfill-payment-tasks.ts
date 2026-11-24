// One-time write of the Today payment tasks (#2079) for debts that existed
// before payment tasks were stored: every unpaid lease month, stay balance and
// deposit or retainer. The same statements the money writes use; repeating it
// changes nothing. Run after migration 0003 has applied.
//
// Usage:
//   yarn db:payment-tasks --staging --dry-run
//   yarn db:payment-tasks --staging
//   yarn db:payment-tasks --production --dry-run
//   yarn db:payment-tasks --production
//
// Each organization reports the dues its stored rows hold and the open tasks
// after the run; a write run fails unless they are equal.
import { parseArgs } from 'node:util'
import { Miniflare } from 'miniflare'
import { startRemoteProxySession, unstable_readConfig } from 'wrangler'
import { queryAll, type DbClient } from '../server/db/index.ts'
import { writeExistingPaymentTasks } from '../server/domain/unpaid.ts'

const { values } = parseArgs({
  options: { staging: { type: 'boolean', default: false }, production: { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false } },
  strict: true,
})
if (values.staging === values.production) throw new Error('Pass exactly one of --staging or --production.')
const write = !values['dry-run']

const envName = values.staging ? 'staging' : undefined
const config = unstable_readConfig({ config: 'wrangler.toml', env: envName }, { hideWarnings: true })
const database = config.d1_databases.find((binding: { binding: string }) => binding.binding === 'DB')
if (!database?.database_id) throw new Error(`wrangler.toml has no DB database_id for ${envName ?? 'production'}`)

const session = await startRemoteProxySession({ DB: { type: 'd1', database_id: database.database_id } })
const runtime = new Miniflare({
  workers: [{
    dev: { remoteProxyConnectionString: session.remoteProxyConnectionString },
    config: {
      name: 'backfill-payment-tasks',
      compatibilityDate: config.compatibility_date ?? '2024-11-01',
      manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } } },
      env: { DB: { type: 'd1', id: database.database_id, dev: { remote: true } } },
    },
  }],
})
try {
  const db = await runtime.getD1Database('DB') as unknown as DbClient
  const organizations = await queryAll<{ id: string; slug: string }>(db, 'SELECT id, slug FROM organization ORDER BY id')
  const report = []
  for (const organization of organizations) {
    const result = await writeExistingPaymentTasks(db, organization.id, { write })
    if (result.bookings) report.push({ organization: organization.slug, ...result })
    if (write && result.open_tasks !== result.dues) throw new Error(`${organization.slug}: ${result.dues} dues but ${result.open_tasks} open payment tasks`)
  }
  console.log(`Payment tasks on ${database.database_name}${write ? '' : ' (dry run, nothing written)'}:\n`, JSON.stringify(report, null, 2))
} finally {
  await runtime.dispose()
  await session.dispose()
}
