import { z } from 'zod'
import { dashboardPresentationSchema } from './dashboard-presentation'
import { insightsIndexSchema } from './insights'

export const dashboardMenuSchema = z.object({
  title: z.string(),
  presentation: dashboardPresentationSchema,
  cards: z.array(z.object({ id: z.string(), title: z.string(), value: z.string(), detail: z.string(), symbol: z.string(), photos: z.array(z.string()), bars: z.array(z.number()) })),
  insights: insightsIndexSchema.nullable(),
})
export type DashboardMenu = z.infer<typeof dashboardMenuSchema>
