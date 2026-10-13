const DISCORD = process.env.DISCORD_WEBHOOK_URL
const SLACK = process.env.SLACK_WEBHOOK_URL
const trim = (s, n) => (s.length <= n ? s : s.slice(0, n - 1) + '…')

export async function notify(title, body, { dry = false } = {}) {
  const text = `**${title}**\n${body}`
  if (dry || (!DISCORD && !SLACK)) return console.log('\n' + text + '\n')
  if (DISCORD) await post(DISCORD, { content: trim(text, 1900) }, 'Discord')
  if (SLACK) await post(SLACK, { text: trim(text, 3000) }, 'Slack')
}
async function post(url, body, label) {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    console.log(r.ok ? `  posted to ${label}` : `  ${label} failed: ${r.status}`)
  } catch (e) { console.error(`  ${label} error: ${e.message}`) }
}
