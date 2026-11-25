import { defineHandler } from 'nitro'
import { getQuery } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { dashboardBookingSearch } from '~/server/utils/dashboard-bookings'

export default defineHandler(async event => jsonResponse(await dashboardBookingSearch(event, getQuery(event))))
