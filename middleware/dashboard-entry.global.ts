import { isDashboardPath } from '~/utils/dashboard-path'

export default defineNuxtRouteMiddleware((to) => {
  // While hydrating, the server already answered this URL: asking it again reloads a 404 forever.
  if (import.meta.client && !useNuxtApp().isHydrating && isDashboardPath(to.path) && !to.matched.some(record => isDashboardPath(record.path))) {
    return navigateTo(to.fullPath, { external: true })
  }
})
