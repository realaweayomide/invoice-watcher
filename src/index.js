// invoice-watcher — tracks what's owed, chases it politely, escalates when it stops working.
//
//   npm run dry    check once, print everything, send nothing, change nothing  ← start here
//   npm run once   check once and send
//   npm start      run on the schedule

import cron from 'node-cron'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { loadInvoices, ageingSummary, status } from './invoices.js'
import { planReminders, shouldSendToday, fmt, DEFAULT_GRACE_DAYS } from './dunning.js'
import { notify } from './notify.js'

const args = process.argv.slice(2)
const ONCE = args.includes('--once')
const DRY = args.includes('--dry')
const STATE = 'data/state.json'
const CUR = process.env.CURRENCY || '$'
const GRACE = Number(process.env.GRACE_DAYS ?? DEFAULT_GRACE_DAYS)
const HOLIDAYS = (process.env.HOLIDAYS || '').split(',').map((s) => s.trim()).filter(Boolean)

const loadState = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {})
const saveState = (s) => writeFileSync(STATE, JSON.stringify(s, null, 2))

async function run() {
  const source = process.env.INVOICES_FILE || 'data/invoices.csv'
  if (!existsSync(source)) { console.error(`[inv] no invoice file at ${source}`); return }

  const invoices = loadInvoices(readFileSync(source, 'utf8'))
  const summary = ageingSummary(invoices)
  const { reminders, nextState, unknown } = planReminders(invoices, loadState(), { currency: CUR, graceDays: GRACE })

  console.log(`[inv] ${summary.count} invoices · ${fmt(summary.outstanding, CUR)} outstanding · ${fmt(summary.overdue, CUR)} overdue`)
  console.log(`[inv] ageing: ${Object.entries(summary.buckets).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${fmt(v, CUR)}`).join(' · ') || 'all clear'}`)
  for (const u of unknown) console.warn(`  skipped ${u.invoice.number}: ${u.note}`)

  // Don't chase people on days their finance team isn't in.
  const guard = shouldSendToday(new Date(), HOLIDAYS)
  if (reminders.length && !guard.send && !DRY) {
    console.log(`[inv] ${reminders.length} reminder(s) ready, but holding: ${guard.reason}. Nothing sent, state unchanged.`)
    return                                   // deliberately does NOT save state — they'll send next working day
  }

  if (!reminders.length) {
    console.log(`[inv] no new reminders to send. (grace period: ${GRACE} days)`)
  } else {
    const digest = [
      `${fmt(summary.overdue, CUR)} overdue across ${reminders.length} customer(s)`,
      '',
      ...reminders.map((r) =>
        `• **${r.customer}** — ${fmt(r.total, CUR)}, oldest ${r.worst}d · _${r.stage.label}_` +
        (r.previousStage ? ` (was: ${r.previousStage})` : '') +
        (r.email ? '' : '  ⚠ no email on file')),
    ].join('\n')
    await notify('Receivables', digest, { dry: DRY })

    for (const r of reminders) {
      console.log(`\n──── ${r.customer} · ${r.stage.id.toUpperCase()} ${r.message.internal ? '(internal)' : `→ ${r.email || 'NO EMAIL'}`}`)
      console.log(`Subject: ${r.message.subject}\n`)
      console.log(r.message.body)
    }
    if (!DRY) console.log('\n[inv] (wire sendMail() here to actually send — see README)')
  }

  if (!DRY) saveState(nextState)
}

if (ONCE) {
  run().catch((e) => { console.error('[inv] failed:', e); process.exit(1) })
} else {
  const schedule = process.env.CRON_SCHEDULE || '0 9 * * 1-5'
  const timezone = process.env.TIMEZONE || 'Africa/Lagos'
  if (!cron.validate(schedule)) { console.error(`Invalid CRON_SCHEDULE: "${schedule}"`); process.exit(1) }
  cron.schedule(schedule, () => run().catch((e) => console.error('[inv] run failed:', e)), { timezone })
  console.log(`[inv] scheduled "${schedule}" (${timezone}).`)
  console.log('[inv] tip: `npm run dry` prints everything without sending or saving state.')
}
