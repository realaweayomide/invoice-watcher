// invoices.js — load invoices, work out what's actually owed, and how late it is.
//
// A note on days, because it's the opposite choice to my stale-deal-detector and that's
// deliberate: THAT counts business days (a deal isn't stale because of the weekend). THIS
// counts CALENDAR days, because payment terms are written in calendar days. "Net 30" means
// thirty calendar days, and an invoice doesn't become less overdue because Saturday happened.
//
// Copying a rule from one monitor to another without asking which clock the domain uses is how
// you end up chasing people five days early.

const DAY = 86400000

const ALIASES = {
  number:   ['number','invoice','invoice number','invoice no','ref','reference','id','invoice id'],
  customer: ['customer','client','company','account','bill to','customer name'],
  email:    ['email','customer email','contact email','bill to email'],
  amount:   ['amount','total','invoice total','value','gross','amount due'],
  paid:     ['paid','amount paid','paid amount','received','payments'],
  issued:   ['issued','issue date','invoice date','date','created'],
  due:      ['due','due date','payment due','date due'],
  terms:    ['terms','payment terms','net','net terms'],
}

function splitLine(line) {
  const out = []; let cur = '', q = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++ } else q = !q }
    else if (c === ',' && !q) { out.push(cur); cur = '' }
    else cur += c
  }
  out.push(cur)
  return out.map((s) => s.trim())
}

const norm = (s) => s.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
const money = (v) => Number(String(v ?? '').replace(/[^0-9.-]/g, '')) || 0

/** "Net 30", "30", "net30", "due on receipt" → days */
function termDays(raw) {
  const s = String(raw ?? '').toLowerCase()
  if (/receipt|immediate/.test(s)) return 0
  const m = s.match(/(\d+)/)
  return m ? Number(m[1]) : null
}

export function loadInvoices(text) {
  const trimmed = text.trim()
  let rows
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const data = JSON.parse(trimmed)
    rows = Array.isArray(data) ? data : data.invoices || []
  } else {
    const lines = trimmed.replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim())
    if (lines.length < 2) throw new Error('Need a header row and at least one invoice.')
    const headers = splitLine(lines[0]).map(norm)
    const map = {}
    for (const [field, names] of Object.entries(ALIASES)) {
      const i = headers.findIndex((h) => names.includes(h))
      if (i !== -1) map[field] = i
    }
    const missing = ['customer', 'amount'].filter((f) => map[f] === undefined)
    if (missing.length || (map.due === undefined && map.issued === undefined)) {
      throw new Error(
        `Couldn't find column(s) for: ${[...missing, map.due === undefined && map.issued === undefined ? 'due date or issue date' : null]
          .filter(Boolean).join(', ')}. Found: ${headers.join(', ')}`)
    }
    rows = lines.slice(1).map((line, i) => {
      const c = splitLine(line)
      const get = (f) => (map[f] !== undefined ? c[map[f]] : undefined)
      return {
        number: get('number') || `row-${i + 2}`, customer: get('customer'), email: get('email'),
        amount: get('amount'), paid: get('paid'), issued: get('issued'), due: get('due'), terms: get('terms'),
      }
    })
  }
  return rows.map(normalise).filter((inv) => inv.customer)
}

function normalise(r) {
  const amount = money(r.amount)
  const paid = money(r.paid)
  const issued = r.issued ? new Date(r.issued) : null
  const terms = termDays(r.terms)

  // Prefer an explicit due date; otherwise derive it from issue date + terms; default Net 30.
  let due = r.due ? new Date(r.due) : null
  let derived = false
  if ((!due || isNaN(due)) && issued && !isNaN(issued)) {
    due = new Date(issued.getTime() + (terms ?? 30) * DAY)
    derived = true
  }

  return {
    number: String(r.number ?? '').trim() || '(no number)',
    customer: String(r.customer ?? '').trim(),
    email: String(r.email ?? '').trim() || null,
    amount, paid,
    outstanding: Math.max(0, Number((amount - paid).toFixed(2))),
    issued: issued && !isNaN(issued) ? issued.toISOString().slice(0, 10) : null,
    due: due && !isNaN(due) ? due.toISOString().slice(0, 10) : null,
    dueDerived: derived,
    terms,
  }
}

/** Where an invoice sits today. */
export function status(inv, now = new Date()) {
  const today = new Date(now); today.setHours(0, 0, 0, 0)

  if (inv.outstanding <= 0) return { state: 'paid', daysOverdue: 0, bucket: 'paid' }
  if (!inv.due) return { state: 'unknown', daysOverdue: 0, bucket: 'unknown', note: 'No due date and no issue date to derive one from' }

  const due = new Date(inv.due); due.setHours(0, 0, 0, 0)
  const daysOverdue = Math.floor((today - due) / DAY)

  if (daysOverdue < 0) return { state: inv.paid > 0 ? 'partial' : 'open', daysOverdue: 0, bucket: 'current', dueIn: -daysOverdue }
  const bucket = daysOverdue === 0 ? 'due today'
    : daysOverdue <= 30 ? '1-30'
    : daysOverdue <= 60 ? '31-60'
    : daysOverdue <= 90 ? '61-90' : '90+'
  return { state: inv.paid > 0 ? 'partially paid, overdue' : 'overdue', daysOverdue, bucket }
}

/** The number a business owner actually asks for. */
export function ageingSummary(invoices, now = new Date()) {
  const buckets = { current: 0, 'due today': 0, '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0 }
  let outstanding = 0, overdue = 0, paidCount = 0, unknown = 0

  for (const inv of invoices) {
    const s = status(inv, now)
    if (s.state === 'paid') { paidCount++; continue }
    if (s.state === 'unknown') { unknown++; continue }
    outstanding += inv.outstanding
    buckets[s.bucket] = (buckets[s.bucket] || 0) + inv.outstanding
    if (s.daysOverdue > 0 || s.bucket === 'due today') overdue += inv.outstanding
  }
  return {
    outstanding: Number(outstanding.toFixed(2)),
    overdue: Number(overdue.toFixed(2)),
    buckets, paidCount, unknown, count: invoices.length,
  }
}
