import { BIN } from "./args.js";

/**
 * Single source of truth for skills/openpanel-axi/SKILL.md.
 *
 * The shipped skill stays a minimal stub: the CLI's own dashboard and
 * `--help` output are authoritative, so guidance is pointed at rather than
 * restated here. `npm run build:skill` writes it; CI runs `--check`.
 */
export const SKILL_NAME = BIN;

export const SKILL_DESCRIPTION = `Work with OpenPanel through the ${BIN} CLI — read visitors, sessions, bounce rate, top pages, traffic sources, geography, devices, UTM campaigns, and raw events; manage projects and API clients; and record events or identify profiles. Works against openpanel.dev cloud or a self-hosted instance. Use whenever a task touches site or product analytics: how much traffic a page or campaign got, where visitors came from, whether a release moved the numbers, what a specific event recorded, or minting an API client for a project.`;

export function renderSkill() {
  return `---
name: ${SKILL_NAME}
description: >
  ${SKILL_DESCRIPTION}
user-invocable: false
metadata:
  hermes:
    tags: [openpanel, analytics, web-analytics, product-analytics, self-hosted]
---

# ${SKILL_NAME}

Run the CLI with no arguments first — it prints live visitors, this week's metrics, the top
pages and traffic sources, plus the next commands to run.

\`\`\`sh
npx -y ${BIN}
\`\`\`

Requires a \`read\` (or \`root\`) OpenPanel API client in the environment. The default client
a project ships with is **write-only** and cannot read analytics:

\`\`\`sh
export OPENPANEL_CLIENT_ID=...       # Settings -> API Clients -> new client, type "read"
export OPENPANEL_CLIENT_SECRET=...
export OPENPANEL_PROJECT_ID=...      # the uuid in the dashboard URL
export OPENPANEL_API_URL=...         # self-hosted only, e.g. https://openpanel.example.com/api
\`\`\`

## Commands

\`\`\`sh
npx -y ${BIN}                          # dashboard: live, 7d metrics, top pages and sources
npx -y ${BIN} metrics --range 30d      # visitors, sessions, pageviews, bounce, duration
npx -y ${BIN} metrics --series         # the same, per interval
npx -y ${BIN} live                     # visitors active right now
npx -y ${BIN} pages --limit 25         # top pages by sessions
npx -y ${BIN} top referrer_name        # also: country, city, device, browser, os, utm_source, ...
npx -y ${BIN} events --event signup    # raw events, newest first
npx -y ${BIN} events names             # which event names exist — start here
npx -y ${BIN} funnel view_pricing signup     # conversion + biggest drop-off
npx -y ${BIN} flow screen_view         # where visitors go next
npx -y ${BIN} retention                # or \`retention cohort\`
npx -y ${BIN} active-users --days 30   # rolling MAU
npx -y ${BIN} pages performance --sort bounce_rate
npx -y ${BIN} sessions --country NL
npx -y ${BIN} profiles --performed signup
npx -y ${BIN} gsc opportunities        # SEO wins, if Search Console is connected

npx -y ${BIN} projects                 # project ids            (root client)
npx -y ${BIN} clients list             # API clients and types  (root client)
npx -y ${BIN} clients create --name "agent reads" --type read --project <id>
npx -y ${BIN} projects create --name "My Blog" --domain https://blog.example.com
npx -y ${BIN} references create --title "v2 launch" --at 2026-09-06T12:00:00Z

npx -y ${BIN} track event deploy_finished --property service=api   (write client)
npx -y ${BIN} track identify user_123 --email a@b.com
npx -y ${BIN} track increment user_123 credits --by 10
npx -y ${BIN} track group acme --type company --name "Acme Inc"
\`\`\`

Every command takes \`--help\` for a concise reference, and \`--project <id>\` to read a
project other than the default.

## What to rely on

- **The project id is never guessed.** Without \`--project\` or \`OPENPANEL_PROJECT_ID\` the
  command stops. Older OpenPanel releases answer an unknown project with an empty 200, so a
  guessed id would look like "no traffic" rather than a mistake.
- **Windows are named.** \`--range\` takes \`today\`, \`yesterday\`, \`7d\`, \`30d\`, \`3m\`, \`12m\`,
  \`monthToDate\`, \`lastMonth\`, \`yearToDate\`, and friends; \`--start\`/\`--end\` cover anything else.
  An unknown range fails before the request and lists the valid ones.
- **Totals, not pages.** Lists report \`count: N of M total\` so the real size is known in one
  call, and the help line names the flag that shows the rest.
- **Zero is stated.** An empty window says so explicitly instead of printing nothing.
- **\`--fields\` widens a row.** \`sessions\`, \`profiles\` and \`events\` project a wide upstream
  record down to what a decision needs; \`--fields utm_source,os\` adds columns back, and an
  unknown name lists every field the record actually carries.
- **Errors are structured** on stdout with a \`help\` block naming the fix — a write-only
  client, a wrong API URL, or rate limiting each say which. An unknown flag exits 2 listing
  the valid flags. Correct the flag; do not drop the filter.

## Writing

Reads and writes take **different client types**, so they come from different variables:

\`\`\`sh
export OPENPANEL_WRITE_CLIENT_ID=...      # a \`write\` client, for \`track\`
export OPENPANEL_WRITE_CLIENT_SECRET=...
\`\`\`

A \`root\` client in \`OPENPANEL_CLIENT_ID\` covers reads, writes, and \`projects\`/\`clients\`.

- **\`track event\` is not idempotent.** Every run records another event, permanently, in the
  numbers you are being asked to interpret. Never re-run it to "check" — read it back with
  \`events --event <name>\`. \`track identify\` is an upsert and is safe to repeat.
- **\`clients create\` prints the secret once.** It cannot be retrieved again. It defaults to
  type \`read\`, not the API's \`write\` default.
- **\`clients delete\` is permanent**, and anything still using that secret starts getting 401.
- **There is no \`projects delete\`.** Removing a project is a dashboard action on purpose.
- **\`track increment\`/\`decrement\` accumulate**, like \`track event\`. \`identify\`, \`group\`,
  and \`alias\` are upserts and are safe to repeat.

## Version and connectivity

Funnels, retention, flow, engagement, profiles, sessions, page performance, and GSC need
**OpenPanel 2.3 or newer**. On an older self-hosted instance they return a \`NOT_FOUND\` that
says so; the core reads (\`metrics\`, \`pages\`, \`top\`, \`events\`, \`live\`) work everywhere.

\`gsc\` additionally needs Google Search Console connected to the project, which is an OAuth
flow in the dashboard — this CLI cannot do the setup, only read the data.

Prefer this over calling the OpenPanel REST API with \`curl\`, or reasoning from the tracking
snippet in the app's source.
`;
}
