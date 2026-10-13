# Invoice Watcher

Tracks what you're owed, chases it politely, escalates when polite stops working — and never
sends the same message twice.

Built by [Ayomide Awe](https://github.com/realaweayomide)

## Try it

```bash
npm install
npm test       # 26 tests, no network
npm run dry    # full ageing report + drafted reminders, sends nothing
```

No API key. No model. This is date arithmetic, grouping and a state file.

## What it gives you

```
8 invoices · $26,430.00 outstanding · $24,400.00 overdue
ageing: current $2,030 · 1-30 $7,200 · 31-60 $17,200
skipped INV-2048: No due date and no issue date to derive one from

$24,400.00 overdue across 4 customer(s)
• Meridian Health      — $2,200,  oldest 42d · Seriously overdue
• Zenith Partners      — $15,000, oldest 35d · Seriously overdue
• Harbour Foods        — $2,400,  oldest 24d · Overdue  ⚠ no email on file
• Northwind Logistics  — $6,050,  oldest 12d · Overdue
```

…plus a drafted message per customer, in the right register.

## Three decisions that make it usable

**1. One message per customer, not per invoice.**

A customer with four overdue invoices gets **one** email listing four lines. Four separate emails
reads as a broken system — and they'll reply to one of them, which is the one you then can't
find. The customer's tone is set by their **oldest** invoice: if one is 60 days late, a breezy
note about the others is the wrong register.

**2. The tone escalates, but only once per stage.**

| Days overdue | Stage | Register |
|---|---|---|
| due within 3 days | reminder | friendly heads-up |
| 1–7 | nudge | "this appears to be just past due" |
| 8–30 | chase | "could you confirm the expected payment date?" |
| 31–60 | final | formal notice |
| 61+ | escalate | **internal** — stop automating, call them |

A customer at "chase" who's still quiet tomorrow gets **nothing**. They only hear from you again
when they cross into "final". Sending the same polite nudge every morning trains people to
ignore you; sending "final notice" every morning is worse.

The last stage deliberately produces an **internal** message, not a customer one. Past 60 days,
an automated email is no longer the right tool and pretending otherwise just delays the phone
call that will actually work.

**3. Calendar days — and that's the opposite of my other monitor.**

My [stale-deal-detector](https://github.com/realaweayomide/stale-deal-detector) counts **business
days**, because a deal isn't stale just because the weekend happened. This one counts **calendar
days**, because payment terms are written in calendar days: "Net 30" means thirty calendar days,
and an invoice doesn't become less overdue because Saturday occurred.

Copying a rule from one monitor into another without asking which clock the domain actually uses
is how you end up chasing customers five days early.

## It handles the messy parts

- **Due dates derived from terms** when absent — `Net 30`, `net60`, `14`, `due on receipt` all parse.
- **Partial payments** — a $3,200 invoice with $1,000 paid is chased for $2,200, and labelled
  "partially paid, overdue" rather than being treated as unpaid.
- **Column aliases** — `Customer`, `Client`, `Account`, `Bill To` all map to the same field,
  because every system exports differently.
- **Missing data is surfaced, never guessed** — an invoice with no dates is skipped *with the
  reason printed*, and a customer with no email is flagged `⚠ no email on file` in the digest
  rather than silently dropped.

## Commands

| | |
|---|---|
| `npm run dry` | print the report and every drafted message, change nothing |
| `npm run once` | run and send, update state |
| `npm start` | run on `CRON_SCHEDULE` (default 9am weekdays) |

Digests go to `DISCORD_WEBHOOK_URL` / `SLACK_WEBHOOK_URL`. The reminder bodies print to the
console — wire your own mail provider where the README points, deliberately, so nobody
accidentally emails real customers while testing.

## License

MIT
