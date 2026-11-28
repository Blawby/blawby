import { z } from 'zod'
import { dashboardPresentationSchema } from './dashboard-presentation'
import { insightsIndexSchema } from './insights'

const navigationRow = z.object({ id: z.string(), label: z.string(), icon: z.string(), native: z.string(), to: z.string().optional(), external_url: z.string().url().optional(), subtitle: z.string().optional(), detail: z.string().optional(), action: z.object({}).optional() })

export const dashboardMenuSchema = z.object({
  title: z.string(),
  navigation: z.array(navigationRow),
  permissions: z.object({ payments: z.boolean(), billing: z.boolean(), team: z.boolean(), invite: z.boolean() }),
  primary_action: navigationRow.nullable(),
  presentation: dashboardPresentationSchema,
  cards: z.array(z.object({ id: z.string(), title: z.string(), value: z.string(), detail: z.string(), symbol: z.string(), photos: z.array(z.string()), bars: z.array(z.number()) })),
  insights: insightsIndexSchema.nullable(),
})
export type DashboardMenu = z.infer<typeof dashboardMenuSchema>
