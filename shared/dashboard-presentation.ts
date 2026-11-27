import { z } from 'zod'

const palette = z.object({ background: z.string(), card: z.string(), text: z.string(), secondary: z.string(), border: z.string(), accent: z.string() })
/** Native dashboard presentation is composed by the platform; iOS applies accessibility scaling. */
export const dashboardPresentationSchema = z.object({
  gap: z.number(), minimum_card_width: z.number(), card_padding: z.number(), card_height: z.number(), corner_radius: z.number(),
  title_size: z.number(), body_size: z.number(), value_size: z.number(), shadow_radius: z.number(), shadow_opacity: z.number(),
  light: palette, dark: palette,
})
export const dashboardPresentation = dashboardPresentationSchema.parse({
  gap: 12, minimum_card_width: 160, card_padding: 16, card_height: 184, corner_radius: 16,
  title_size: 17, body_size: 14, value_size: 16, shadow_radius: 8, shadow_opacity: 0.08,
  light: { background: '#FFFFFF', card: '#FFFFFF', text: '#222222', secondary: '#6A6A6A', border: '#EBEBEB', accent: '#D70466' },
  dark: { background: '#161616', card: '#222222', text: '#F7F7F7', secondary: '#B0B0B0', border: '#404040', accent: '#FF5A96' },
})
export type DashboardPresentation = z.infer<typeof dashboardPresentationSchema>

/** A dense operational grid: header controls share one toolbar above pinned dates. */
export const calendarPresentation = {
  title: 'All homes', settings_label: 'Calendar settings', row_height: 48, home_column_width: 172,
  day_column_width: 64, day_header_height: 40, filter_control_height: 44, theme: dashboardPresentation,
}
