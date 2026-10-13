// dunning.js — decide who to chase, how firmly, and in how many messages.
//
// Two rules that most chasing tools get wrong:
//
//   1. ONE MESSAGE PER CUSTOMER, NOT PER INVOICE. A customer with four overdue invoices should
//      get one email listing four lines — not four emails. Four emails reads as a broken system,
//      and the customer replies to one of them, which is the one you then can't find.
//
//   2. THE TONE ESCALATES, BUT ONLY ONCE PER STAGE. Sending the same polite nudge every morning
//      trains people to ignore you; sending the "final notice" every morning is worse. Each
//      customer moves through the stages at most once, and the state file remembers where they got to.

import { status } from './invoices.js'

export const STAGES = [
  { id: 'reminder', from: -3,  tone: 'friendly',  label: 'Upcoming' },
  { id: 'nudge',    from: 1,   tone: 'polite',    label: 'Just overdue' },
  { id: 'chase',    from: 8,   tone: 'firm',      label: 'Overdue' },
  { id: 'final',    from: 31,  tone: 'formal',    label: 'Seriously overdue' },
  { id: 'escalate', from: 61,  tone: 'escalated', label: 'For human attention' },
]

/**
 * GRACE PERIOD — why this exists:
 * Bank transfers take one to three days to clear. An invoice that is "1 day overdue" has very
 * often already been paid, and the payment is simply in flight. Chasing on day one costs you
 * goodwill over nothing, and trains the customer to ignore the next message because the last
 * one was wrong.
 *
 * So nothing is chased until it is past due BY MORE THAN the grace period. Default 3 days.
 * Set it to 0 if you invoice on receipt and expect instant payment.
 */
export const DEFAULT_GRACE_DAYS = 3

export function stageFor(daysOverdue, dueIn = null, graceDays = DEFAULT_GRACE_DAYS) {
  if (daysOverdue <= 0) return dueIn !== null && dueIn <= 3 ? STAGES[0] : null
  if (daysOverdue <= graceDays) return null          // payment may simply be in transit
  let found = null
  for (const s of STAGES) if (s.from > 0 && daysOverdue >= s.from) found = s
  return found
}

/**
 * SEND GUARD — don't chase people on days their finance team isn't working.
 * A reminder landing on a public holiday is both useless and slightly rude.
 */
export function shouldSendToday(now = new Date(), holidays = []) {
  const day = now.getDay()
  if (day === 0 || day === 6) return { send: false, reason: 'weekend' }
  const iso = now.toISOString().slice(0, 10)
  if (holidays.includes(iso)) return { send: false, reason: `holiday (${iso})` }
  return { send: true }
}

const fmt = (n, cur = '$') => cur + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/**
 * Group overdue invoices by customer and work out what to send.
 * @param {object} state  previous run: { [customer]: stageId }
 */
export function planReminders(invoices, state = {}, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date()
  const currency = opts.currency || '$'
  const grace = opts.graceDays ?? DEFAULT_GRACE_DAYS
  const byCustomer = new Map()
  const unknown = []

  for (const inv of invoices) {
    const s = status(inv, now)
    if (s.state === 'paid') continue
    if (s.state === 'unknown') { unknown.push({ invoice: inv, note: s.note }); continue }

    const stage = stageFor(s.daysOverdue, s.dueIn ?? null, grace)
    if (!stage) continue

    const entry = byCustomer.get(inv.customer) || { customer: inv.customer, email: inv.email, lines: [], total: 0, worst: 0 }
    entry.email = entry.email || inv.email
    entry.lines.push({ ...inv, daysOverdue: s.daysOverdue, bucket: s.bucket, state: s.state })
    entry.total += inv.outstanding
    entry.worst = Math.max(entry.worst, s.daysOverdue)
    byCustomer.set(inv.customer, entry)
  }

  const reminders = [], nextState = {}

  for (const entry of byCustomer.values()) {
    // The customer's stage is set by their OLDEST invoice — if one is 60 days late, a polite
    // note about the others is the wrong register.
    const stage = stageFor(entry.worst, entry.lines[0]?.daysOverdue <= 0 ? 1 : null, grace) || STAGES[0]
    nextState[entry.customer] = stage.id

    if (state[entry.customer] === stage.id) continue      // already said this; say nothing

    entry.lines.sort((a, b) => b.daysOverdue - a.daysOverdue)
    reminders.push({
      ...entry,
      total: Number(entry.total.toFixed(2)),
      stage,
      previousStage: state[entry.customer] || null,
      message: compose(entry, stage, currency),
    })
  }

  reminders.sort((a, b) => (b.worst - a.worst) || (b.total - a.total))
  return { reminders, nextState, unknown }
}

function compose(entry, stage, cur) {
  const name = entry.customer
  const lines = entry.lines
    .map((l) => `  • ${l.number} — ${fmt(l.outstanding, cur)} — due ${l.due}${l.daysOverdue > 0 ? ` (${l.daysOverdue} days overdue)` : ' (due shortly)'}`)
    .join('\n')
  const total = fmt(entry.total, cur)
  const many = entry.lines.length > 1

  const bodies = {
    reminder: `Hi ${name},\n\nA quick heads-up that ${many ? 'these invoices are' : 'this invoice is'} due shortly:\n\n${lines}\n\nTotal: ${total}\n\nNo action needed if payment is already on its way.`,
    nudge: `Hi ${name},\n\n${many ? 'These invoices appear' : 'This invoice appears'} to be just past due:\n\n${lines}\n\nTotal outstanding: ${total}\n\nIf it's already been paid, apologies — just let us know the date and we'll match it up.`,
    chase: `Hi ${name},\n\nFollowing up on ${many ? 'these outstanding invoices' : 'this outstanding invoice'}:\n\n${lines}\n\nTotal outstanding: ${total}\n\nCould you confirm the expected payment date? If there's a problem with the invoice, tell us and we'll sort it.`,
    final: `${name},\n\nThe following ${many ? 'invoices remain' : 'invoice remains'} unpaid and ${many ? 'are' : 'is'} now significantly overdue:\n\n${lines}\n\nTotal outstanding: ${total}\n\nPlease arrange payment, or contact us to agree a plan. We'd rather resolve this directly.`,
    escalate: `INTERNAL — needs a human.\n\n${name} has ${fmt(entry.total, cur)} outstanding, oldest ${entry.worst} days overdue:\n\n${lines}\n\nAutomated reminders have run their course. Someone should call them before this goes further.`,
  }
  return { subject: subjectFor(stage, name, entry, cur), body: bodies[stage.id], internal: stage.id === 'escalate' }
}

const subjectFor = (stage, name, entry, cur) => ({
  reminder: `Upcoming invoice${entry.lines.length > 1 ? 's' : ''} — ${fmt(entry.total, cur)}`,
  nudge: `Invoice${entry.lines.length > 1 ? 's' : ''} just past due — ${fmt(entry.total, cur)}`,
  chase: `Overdue invoice${entry.lines.length > 1 ? 's' : ''} — ${fmt(entry.total, cur)}`,
  final: `Formal notice: ${fmt(entry.total, cur)} outstanding`,
  escalate: `[ACTION] ${name} — ${fmt(entry.total, cur)}, ${entry.worst} days overdue`,
}[stage.id])

export { fmt }
