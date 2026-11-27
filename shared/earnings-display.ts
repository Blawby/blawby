import { dashboardPresentationSchema, type DashboardPresentation } from './dashboard-presentation'
import {isCurrencyCode} from './currencies'
import {paymentMoney} from './payment-display'

/** What `/api/dashboard/payments` answers for a period with no `view`: the summary the Menu's Earnings card shows. */
export interface EarningsAmount { currency:string; captured_amount:number; refunded_amount:number; disputed_amount:number }
export interface EarningsSummary { summary:{ amounts:EarningsAmount[]; refreshed_at:string }; currency:string }
export function isEarningsSummary(value:unknown):value is EarningsSummary {
 if(!value||typeof value!=='object'||!('summary' in value)||!value.summary||typeof value.summary!=='object')return false
 const summary=value.summary as Record<string,unknown>
 return isCurrencyCode((value as Record<string,unknown>).currency)&&typeof summary.refreshed_at==='string'&&Array.isArray(summary.amounts)&&summary.amounts.every((row:unknown)=>!!row&&typeof row==='object'&&isCurrencyCode((row as Record<string,unknown>).currency)&&['captured_amount','refunded_amount','disputed_amount'].every(field=>Number.isSafeInteger((row as Record<string,unknown>)[field])))
}
/** Money kept this period — paid less refunded — per currency, as Airbnb's "Total for October". */
export function earningsPaid(summary:EarningsSummary|null|undefined):Array<{currency:string;amount:number}> {
 return (summary?.summary.amounts??[]).map(row=>({currency:row.currency,amount:row.captured_amount-row.refunded_amount}))
}
/** The one figure a card shows: what was earned, or nothing yet in the currency the business sells in. */
export function earningsFigure(summary:EarningsSummary):string {
 const paid=earningsPaid(summary)
 return paid.length?paid.map(row=>paymentMoney(row.amount,row.currency)).join(' · '):paymentMoney(0,summary.currency)
}

/** What `view=performance` answers: the year by month and one month by what was sold. */
export interface EarningsPerformance {
 presentation:DashboardPresentation
 booking_value_title:string
 breakdown:Array<{key:string;label:string;display:string}>
 statistics:Array<{key:string;label:string;display:string}>
 comparison?:{year:number;currency:string;months:Array<{month:string;paid:number;refunded:number}>}
 currency:string
 payouts_connected?:boolean|null
 channel_reservations:Array<{channel:string;currency:string;amount:number;count:number}>
 months:Array<{month:string;paid:number;refunded:number}>
 items:Array<{title:string;image_url:string|null;paid:number;count:number}>
}
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
const earningsDetails=(value:unknown)=>Array.isArray(value)&&value.length>0&&value.every(row=>record(row)&&['key','label','display'].every(key=>typeof row[key]==='string'&&row[key].length>0))
const earningsMonths=(value:unknown):value is EarningsPerformance['months']=>Array.isArray(value)&&value.length===12&&value.every((row,index)=>record(row)&&typeof row.month==='string'&&/^\d{4}-(0[1-9]|1[0-2])$/.test(row.month)&&row.month===`${value[0].month.slice(0,4)}-${String(index+1).padStart(2,'0')}`&&Number.isSafeInteger(row.paid)&&Number.isSafeInteger(row.refunded))
export function isEarningsPerformance(value:unknown):value is EarningsPerformance {
 return record(value)&&dashboardPresentationSchema.safeParse(value.presentation).success&&isCurrencyCode(value.currency)
  &&typeof value.booking_value_title==='string'&&earningsDetails(value.breakdown)&&earningsDetails(value.statistics)
  &&(value.payouts_connected==null||typeof value.payouts_connected==='boolean')
  &&Array.isArray(value.channel_reservations)&&value.channel_reservations.every(row=>record(row)&&['airbnb','booking_com','vrbo'].includes(String(row.channel))&&isCurrencyCode(row.currency)&&Number.isSafeInteger(row.amount)&&Number(row.amount)>=0&&Number.isSafeInteger(row.count)&&Number(row.count)>0)
  &&earningsMonths(value.months)
  &&(value.comparison===undefined||(record(value.comparison)&&Number.isSafeInteger(value.comparison.year)&&isCurrencyCode(value.comparison.currency)&&earningsMonths(value.comparison.months)))
  &&Array.isArray(value.items)&&value.items.every(row=>record(row)&&typeof row.title==='string'&&(row.image_url===null||typeof row.image_url==='string')&&Number.isSafeInteger(row.paid)&&Number.isSafeInteger(row.count))
}

export interface EarningsOverview { presentation:DashboardPresentation; month:string; performance:EarningsPerformance; payouts:Omit<PayoutsView,'balance'>|null }

export function isEarningsOverview(value: unknown): value is EarningsOverview {
 return record(value) && dashboardPresentationSchema.safeParse(value.presentation).success && typeof value.month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value.month)
  && isEarningsPerformance(value.performance) && value.performance.months.some(row => row.month === value.month) && (value.payouts === null || (record(value.payouts) && typeof value.payouts.configured === 'boolean'
   && (value.payouts.next_cursor === null || typeof value.payouts.next_cursor === 'string') && Array.isArray(value.payouts.payouts)
   && value.payouts.payouts.every(row => moneyRow(row) && typeof row.id === 'string' && ['pending','in_transit','paid','failed','canceled'].includes(String(row.status)) && Number.isSafeInteger(row.arrival_date) && Number.isSafeInteger(row.created))))
}

/** One payment a payout carried, or one line of the transactions list. */
export interface PayoutItem { gross_amount:number; fee_amount:number; buyer_name:string|null; payment_id:string; title:string; image_url:string|null; amount:number; currency:string; starts_at:string|null; ends_at:string|null; timezone:string|null; name:string|null }
export function isPayoutItem(value:unknown):value is PayoutItem {
 return record(value)&&typeof value.payment_id==='string'&&typeof value.title==='string'&&(value.image_url===null||typeof value.image_url==='string')&&Number.isSafeInteger(value.amount)&&isCurrencyCode(value.currency)
  &&Number.isSafeInteger(value.gross_amount)&&Number.isSafeInteger(value.fee_amount)&&Number(value.gross_amount)-Number(value.fee_amount)===value.amount
  &&[value.starts_at,value.ends_at,value.timezone,value.name,value.buyer_name].every(field=>field===null||typeof field==='string')
}
export interface PayoutDetail { created:number; id:string; amount:number; currency:string; status:string; arrival_date:number; bank:{bank_name:string|null;last4:string}|null; items:PayoutItem[]; failure_code:string|null; failure_message:string|null }
export function isPayoutDetail(value:unknown):value is PayoutDetail {
 return record(value)&&typeof value.id==='string'&&Number.isSafeInteger(value.amount)&&isCurrencyCode(value.currency)&&typeof value.status==='string'&&Number.isSafeInteger(value.arrival_date)&&Number.isSafeInteger(value.created)
  &&(value.bank===null||(record(value.bank)&&(value.bank.bank_name===null||typeof value.bank.bank_name==='string')&&typeof value.bank.last4==='string'))
  &&Array.isArray(value.items)&&value.items.every(isPayoutItem)
  &&(value.failure_code===null||typeof value.failure_code==='string')
  &&(value.failure_message===null||typeof value.failure_message==='string')
}
/** Stripe's payout list rows, as the Earnings and Paid screens read them. */
export interface PayoutRow { created:number; id:string; amount:number; currency:string; status:string; arrival_date:number }
export interface PayoutsView { configured:boolean; balance?:{available:Array<{amount:number;currency:string}>;pending:Array<{amount:number;currency:string}>}|null; payouts:PayoutRow[]; next_cursor:string|null }
const moneyRow=(value:unknown)=>record(value)&&Number.isSafeInteger(value.amount)&&typeof value.currency==='string'&&isCurrencyCode(value.currency.toUpperCase())
export function isPayoutsView(value:unknown):value is PayoutsView {
 return record(value)&&typeof value.configured==='boolean'&&Array.isArray(value.payouts)&&(value.next_cursor===null||(typeof value.next_cursor==='string'&&!!value.next_cursor))
  &&(value.configured===false||(record(value.balance)&&Array.isArray(value.balance.available)&&value.balance.available.every(moneyRow)&&Array.isArray(value.balance.pending)&&value.balance.pending.every(moneyRow)
   &&value.payouts.every(row=>moneyRow(row)&&typeof row.id==='string'&&['pending','in_transit','paid','failed','canceled'].includes(String(row.status))&&Number.isSafeInteger(row.arrival_date)&&Number.isSafeInteger(row.created))))
}
export function payoutStatusLabel(status:string):string {
 return status==='paid'?'Sent':status==='failed'?'Failed':status==='canceled'?'Cancelled':status==='in_transit'?'On its way':'Expected'
}
export function payoutDate(seconds:number,options:Intl.DateTimeFormatOptions={month:'short',day:'numeric',year:'numeric'}):string {
 return new Date(seconds*1000).toLocaleDateString('en',{timeZone:'UTC',...options})
}

/** One line of the business's transactions list. */
export interface TransactionRow { id:string; created_at:string; currency:string; amount:number; captured_amount:number; refunded_amount:number; title:string; image_url:string|null; buyer_name:string|null; starts_at:string|null; ends_at:string|null; timezone:string|null; to:string }
export function isTransactionsView(value:unknown):value is {payments:TransactionRow[];next_cursor:string|null} {
 return record(value)&&(value.next_cursor===null||typeof value.next_cursor==='string')&&Array.isArray(value.payments)&&value.payments.every(row=>record(row)&&typeof row.id==='string'&&typeof row.created_at==='string'&&isCurrencyCode(row.currency)
  &&['amount','captured_amount','refunded_amount'].every(field=>Number.isSafeInteger(row[field]))&&typeof row.title==='string'&&typeof row.to==='string'
  &&[row.image_url,row.buyer_name,row.starts_at,row.ends_at,row.timezone].every(field=>field===null||typeof field==='string'))
}
/** Rows to a CSV file the browser saves, as Airbnb's "Export CSV". */
export function downloadCsv(filename:string,header:string[],rows:Array<Array<string|number>>):void {
 // A buyer writes their own name, so text a spreadsheet would run as a formula is kept as text.
 const escape=(cell:string|number)=>`"${(typeof cell==='string'&&/^[=+\-@\t\r]/.test(cell)&&!/^-\d+(?:\.\d+)?$/.test(cell)?`'${cell}`:String(cell)).replace(/"/g,'""')}"`
 const text=[header,...rows].map(row=>row.map(escape).join(',')).join('\n')
 downloadCsvText(filename,text)
}
export function downloadCsvText(filename:string,text:string):void {
 const url=URL.createObjectURL(new Blob([text],{type:'text/csv;charset=utf-8'}))
 const link=document.createElement('a'); link.href=url; link.download=filename; link.click(); URL.revokeObjectURL(url)
}

/** Agreed booking values by the visit's local month, distinct from collections and payouts. */
export interface BookingValueReport {
 presentation:DashboardPresentation
 title:string
 bookings_label:string
 future_label:string
 empty_label:string
 note:string
 year:number
 unpriced_label:string
 unpriced_bookings:number
 reports:Array<{currency:string;months:Array<{month:string;total_minor:number;bookings:number}>;items:Array<{product_id:string;title:string;image_url:string|null;month:string;total_minor:number;bookings:number}>}>
}
export function isBookingValueReport(value:unknown):value is BookingValueReport {
 return record(value)&&dashboardPresentationSchema.safeParse(value.presentation).success&&typeof value.title==='string'&&typeof value.bookings_label==='string'&&typeof value.future_label==='string'&&typeof value.empty_label==='string'&&typeof value.note==='string'
  &&Number.isInteger(value.year)&&typeof value.unpriced_label==='string'&&Number.isSafeInteger(value.unpriced_bookings)&&Number(value.unpriced_bookings)>=0
  &&Array.isArray(value.reports)&&value.reports.every(report=>record(report)&&isCurrencyCode(report.currency)&&Array.isArray(report.months)&&report.months.length===12
   &&report.months.every((row,index)=>record(row)&&row.month===`${value.year}-${String(index+1).padStart(2,'0')}`&&Number.isSafeInteger(row.total_minor)&&Number(row.total_minor)>=0&&Number.isSafeInteger(row.bookings)&&Number(row.bookings)>=0)
   &&Array.isArray(report.items)&&report.items.every(row=>record(row)&&typeof row.product_id==='string'&&typeof row.title==='string'&&(row.image_url===null||typeof row.image_url==='string')&&typeof row.month==='string'&&Number.isSafeInteger(row.total_minor)&&Number.isSafeInteger(row.bookings)))
}
