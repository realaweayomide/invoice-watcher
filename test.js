import { loadInvoices, status, ageingSummary } from './src/invoices.js'
import { planReminders, stageFor } from './src/dunning.js'
import { readFileSync } from 'node:fs'

let fails = 0
const check = (n,c,d='') => { console.log((c?'  PASS  ':'  FAIL  ')+n+(d?'  → '+d:'')); if(!c) fails++ }
const NOW = '2026-10-13'

const inv = loadInvoices(readFileSync('data/invoices.csv','utf8'))

// --- loading & due-date derivation ---
check('maps CRM-ish column aliases', inv.length === 8 && inv[0].customer === 'Northwind Logistics', inv[0]?.customer)
check('derives due date from issue date + terms',
  inv[0].due === '2026-10-01' && inv[0].dueDerived, inv[0].due + ' (Net 30 from 2026-09-01)')
check('parses Net 60', inv.find(i=>i.number==='INV-2045').due === '2026-09-08', inv.find(i=>i.number==='INV-2045')?.due)
check('parses Net 14', inv.find(i=>i.number==='INV-2046').due === '2026-10-19', inv.find(i=>i.number==='INV-2046')?.due)
check('computes outstanding after partial payment',
  inv.find(i=>i.number==='INV-2044').outstanding === 2200, String(inv.find(i=>i.number==='INV-2044')?.outstanding))

// --- status ---
const paid = status(inv.find(i=>i.number==='INV-2043'), new Date(NOW))
check('fully paid invoice is paid', paid.state === 'paid')
const partial = status(inv.find(i=>i.number==='INV-2044'), new Date(NOW))
check('partial payment still chases the remainder', /partially paid/.test(partial.state), partial.state+' '+partial.daysOverdue+'d')
const future = status(inv.find(i=>i.number==='INV-2046'), new Date(NOW))
check('not-yet-due invoice is current', future.bucket === 'current' && future.daysOverdue === 0, 'due in '+future.dueIn+'d')
const old = status(inv.find(i=>i.number==='INV-2045'), new Date(NOW))
check('old invoice lands in the right ageing bucket', old.bucket === '31-60', old.daysOverdue+'d → '+old.bucket)
const noDate = status(inv.find(i=>i.number==='INV-2048'), new Date(NOW))
check('invoice with no dates is reported, not guessed', noDate.state === 'unknown', noDate.note)

// --- calendar days, NOT business days (payment terms are calendar) ---
check('a weekend does not pause the clock',
  status({ outstanding: 100, due: '2026-10-09' }, new Date('2026-10-12')).daysOverdue === 3,
  String(status({ outstanding: 100, due:'2026-10-09' }, new Date('2026-10-12')).daysOverdue) + ' (Fri→Mon)')

// --- ageing summary ---
const sum = ageingSummary(inv, new Date(NOW))
check('summary excludes paid invoices', sum.paidCount === 1, sum.paidCount + ' paid')
check('summary totals outstanding', sum.outstanding > 0 && sum.overdue > 0, '$'+sum.outstanding+' out / $'+sum.overdue+' overdue')
check('summary counts unreadable invoices separately', sum.unknown === 1)

// --- dunning stages ---
check('3 days overdue is a polite nudge', stageFor(3).id === 'nudge', stageFor(3)?.id)
check('15 days overdue is a firmer chase', stageFor(15).id === 'chase')
check('45 days overdue is formal', stageFor(45).id === 'final')
check('70 days overdue goes to a human', stageFor(70).id === 'escalate')
check('not overdue sends nothing', stageFor(0) === null)

// --- grouping & anti-nag ---
const first = planReminders(inv, {}, { now: NOW })
const northwind = first.reminders.find(r=>r.customer === 'Northwind Logistics')
check('ONE message per customer, not per invoice',
  northwind && northwind.lines.length === 2, northwind?.lines.length + ' invoices in 1 message')
check('customer total sums their invoices', northwind.total === 6050, String(northwind?.total))
check('tone is set by the OLDEST invoice', northwind.stage.id === 'chase', northwind?.stage.id+' (worst '+northwind?.worst+'d)')
// nothing is 61+ days overdue on 2026-10-13, so escalation is checked on the later run below
check('missing email is surfaced, not silently skipped',
  first.reminders.some(r=>r.customer==='Harbour Foods' && !r.email))

const second = planReminders(inv, first.nextState, { now: NOW })
check('running again repeats nothing', second.reminders.length === 0, second.reminders.length + ' reminders')

const later = planReminders(inv, first.nextState, { now: '2026-11-20' })
check('but a worsening customer DOES get the next stage', later.reminders.length > 0,
  later.reminders.map(r=>r.customer+':'+r.stage.id).join(', ').slice(0,60))
check('escalation message is marked internal',
  later.reminders.find(r=>r.stage.id==='escalate')?.message.internal === true,
  later.reminders.find(r=>r.stage.id==='escalate')?.customer || 'none escalated')

check('messages contain the invoice numbers and totals',
  /INV-2041/.test(northwind.message.body) && /6,050/.test(northwind.message.body))

console.log('\n  ' + (fails ? fails+' FAILED' : 'all passed')); process.exit(fails)
