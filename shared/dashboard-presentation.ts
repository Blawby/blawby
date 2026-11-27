import { z } from 'zod'

const palette = z.object({ background: z.string(), card: z.string(), text: z.string(), secondary: z.string(), border: z.string(), card_border: z.string(), accent: z.string(), comparison_accent: z.string(), rating_accent: z.string() })
/** Native dashboard presentation is composed by the platform; iOS applies accessibility scaling. */
export const dashboardPresentationSchema = z.object({
  gap: z.number(), minimum_card_width: z.number(), card_padding: z.number(), card_height: z.number(), corner_radius: z.number(),
  title_size: z.number(), body_size: z.number(), value_size: z.number(), shadow_radius: z.number(), shadow_opacity: z.number(), shadow_offset_y: z.number(), card_border_width: z.number(),
  light: palette, dark: palette,
})
export const dashboardPresentation = dashboardPresentationSchema.parse({
  gap: 12, minimum_card_width: 160, card_padding: 16, card_height: 184, corner_radius: 16,
  title_size: 17, body_size: 14, value_size: 16, shadow_radius: 10, shadow_opacity: 0.12, shadow_offset_y: 4, card_border_width: 1,
  light: { background: '#FAFAFA', card: '#FFFFFF', text: '#222222', secondary: '#6A6A6A', border: '#EBEBEB', card_border: '#E0E0E0', accent: '#D70466', comparison_accent: '#77216F', rating_accent: '#008489' },
  dark: { background: '#161616', card: '#242424', text: '#F7F7F7', secondary: '#B0B0B0', border: '#404040', card_border: '#505050', accent: '#FF5A96', comparison_accent: '#CA8DC3', rating_accent: '#7CC8C5' },
})
export type DashboardPresentation = z.infer<typeof dashboardPresentationSchema>

/** A dense operational grid: header controls share one toolbar above pinned dates. */
export const calendarPresentation = {
  title: 'All homes', settings_label: 'Calendar settings', row_height: 48, home_column_width: 172,
  day_column_width: 64, day_header_height: 40, filter_control_height: 44, theme: dashboardPresentation,
}

/** Map the server palettes to the web dashboard's semantic color tokens. */
export function dashboardThemeStyle(presentation: DashboardPresentation) {
  return Object.fromEntries((['light', 'dark'] as const).flatMap(mode => {
    const palette = presentation[mode]
    return Object.entries({ background: palette.background, card: palette.card, text: palette.text, secondary: palette.secondary, border: palette.border })
      .map(([key, value]) => [`--dashboard-${key}-${mode}`, value])
  }))
}
