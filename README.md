<h1 align="center">openpanel-axi</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/openpanel-axi"><img alt="npm" src="https://img.shields.io/npm/v/openpanel-axi?style=flat-square" /></a>
  <a href="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=flat-square"><img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=flat-square" /></a>
  <a href="https://axi.md"><img alt="AXI" src="https://img.shields.io/badge/built%20with-AXI-black?style=flat-square" /></a>
</p>

<h3 align="center">OpenPanel analytics CLI for agents.</h3>

Read **visitors, pages, traffic sources, geography, devices, campaigns, and raw events**
from [OpenPanel](https://openpanel.dev) — cloud or self-hosted — plus manage projects and
API clients and record events. Designed with [AXI](https://axi.md) (Agent eXperience
Interface).

Talks to the OpenPanel HTTP API directly. Two environment credentials are the entire
dependency footprint, plus [`axi-sdk-js`](https://www.npmjs.com/package/axi-sdk-js) for the
shared AXI runtime.

## Why

OpenPanel ships an official MCP server, and it is good. It also costs tool-schema tokens on
every turn of every session, needs per-agent registration, and only exists on recent builds
— a self-hosted instance a few months behind serves no `/mcp` at all. The fallback is `curl`
against an API whose vocabulary has to be re-derived each time.

Three things that costs an agent, which this fixes:

- **A wrong project id that looks like no traffic.** Older OpenPanel releases read the
  project straight off the URL with no scoping, so a guessed id returns an empty `200`.
  `openpanel-axi` refuses to send a request it cannot attribute.
- **`401 Invalid client credentials` when the secret is fine.** The client every project
  ships with is write-only. The error here leads with the client *type* and the fix.
- **Unguessable windows.** `--range` is a closed vocabulary (`today`, `7d`, `monthToDate`,
  `lastYear`, …) validated before the request, with `--start`/`--end` for anything else.

Route shapes are verified against the OpenPanel API source, not recalled — see
[AGENTS.md](AGENTS.md).

## Quick Start

Install the skill in the [Agent Skills](https://agentskills.io) format:

```sh
npx skills add radityasurya/openpanel-axi --skill openpanel-axi -g
```

That is the entire setup — no npm install needed. The skill is a discovery stub that sends
your agent to the always-current `npx -y openpanel-axi` dashboard, so it cannot go stale
against a newer CLI.

Then export a `read` client. Create one under **Settings → API Clients** in your OpenPanel
dashboard — type `read` (or `root`), because the client a project ships with is write-only
and cannot read analytics:

```sh
export OPENPANEL_CLIENT_ID=...
export OPENPANEL_CLIENT_SECRET=...
export OPENPANEL_PROJECT_ID=...      # the uuid in your dashboard URL
export OPENPANEL_API_URL=...         # self-hosted only, e.g. https://openpanel.example.com/api
```

| Variable | Required | Purpose |
| --- | --- | --- |
| `OPENPANEL_CLIENT_ID` | yes | Client id of a `read` or `root` client |
| `OPENPANEL_CLIENT_SECRET` | yes | Its secret, shown once at creation |
| `OPENPANEL_PROJECT_ID` | yes, unless `--project` | Which project to read |
| `OPENPANEL_API_URL` | self-hosted | API base URL; defaults to `https://api.openpanel.dev` |
| `OPENPANEL_WRITE_CLIENT_ID` | for `track` | Client id of a `write` client |
| `OPENPANEL_WRITE_CLIENT_SECRET` | for `track` | Its secret |

`projects` and `clients` need a `root` client in `OPENPANEL_CLIENT_ID`. A `root` client
covers every command on its own.

## Other Ways to Install

### Zero setup

It's an AXI, so any capable agent can run it with nothing installed:

```
Execute `npx -y openpanel-axi` for OpenPanel analytics.
```

### Session hook

For ambient context — this week's traffic visible at the start of every agent session:

```sh
npm install -g openpanel-axi
openpanel-axi setup hooks
```

Installs a `SessionStart` hook for **Claude Code**, **Codex**, and **OpenCode**. Restart your
agent session afterwards. `openpanel-axi setup status` reports what is installed;
`openpanel-axi setup uninstall` removes it. You need either the hook or the skill, not both.

## Usage

```bash
openpanel-axi                              # dashboard — live, 7d metrics, top pages and sources
openpanel-axi metrics                      # visitors, sessions, pageviews, bounce, duration
openpanel-axi metrics --range 30d
openpanel-axi metrics --range today --series
openpanel-axi metrics --start 2026-08-01 --end 2026-08-31

openpanel-axi live                         # visitors active right now
openpanel-axi pages --limit 25             # top pages by sessions

openpanel-axi top referrer_name            # where the traffic came from
openpanel-axi top country --range 30d
openpanel-axi top utm_campaign
openpanel-axi top browser

openpanel-axi events                       # raw events, newest first
openpanel-axi events --event signup --properties
openpanel-axi events names                 # which event names exist
openpanel-axi events properties screen_view
openpanel-axi events values screen_view path

openpanel-axi funnel view_pricing checkout purchase --window-hours 72
openpanel-axi flow screen_view --mode after
openpanel-axi retention                    # or `retention cohort`
openpanel-axi engagement
openpanel-axi active-users --days 30       # rolling MAU

openpanel-axi pages entry                  # where sessions start
openpanel-axi pages performance --sort bounce_rate
openpanel-axi sessions --country NL --device mobile
openpanel-axi profiles --performed signup --min-sessions 3
openpanel-axi profiles get <id>

openpanel-axi gsc opportunities            # SEO wins (needs GSC connected)
openpanel-axi gsc queries --range 30d

openpanel-axi projects                     # project ids (root client)
openpanel-axi clients list                 # API clients and their types
openpanel-axi clients create --name "agent reads" --type read --project <id>
openpanel-axi clients delete <id>
openpanel-axi projects create --name "My Blog" --domain https://blog.example.com
openpanel-axi projects update myblog --domain https://new.example.com
openpanel-axi references create --title "v2 launch" --at 2026-09-06T12:00:00Z

openpanel-axi track event deploy_finished --property service=api --property duration=42
openpanel-axi track event signup --profile user_123
openpanel-axi track identify user_123 --email a@b.com --first-name Ada
openpanel-axi track increment user_123 credits --by 10
openpanel-axi track group acme --type company --name "Acme Inc"
openpanel-axi track assign-group user_123 acme

openpanel-axi update --check               # newer release available?
```

### Commands

| Command | Purpose |
| --- | --- |
| *(none)* | Dashboard: live visitors, 7d metrics, top pages and sources |
| `metrics` | Visitors, sessions, pageviews, bounce rate, session duration |
| `live` | Visitors active right now |
| `pages` | `list`, `entry`, `exit`, `performance` |
| `top <dimension>` | Top values for one dimension |
| `events` | `list`, `names`, `properties`, `values` |
| `funnel` | Conversion between 2-10 events, biggest drop-off flagged |
| `flow` | Where visitors go before, after, or between events |
| `retention` | Week-over-week series, or `retention cohort` |
| `engagement` | Engagement summary and distribution |
| `active-users` | Rolling DAU / WAU / MAU |
| `sessions` | Sessions with duration, entry/exit, bounce |
| `profiles` | `list`, `get`, `sessions`, `metrics` |
| `gsc` | `overview`, `pages`, `queries`, `page`, `query`, `opportunities`, `cannibalization` |
| `projects` | `list`, `create`, `update` (no delete, on purpose) |
| `references` | `list`, `create`, `update` timeline markers |
| `clients` | `list`, `create`, `delete` API clients (root client) |
| `track` | `event`, `identify`, `increment`, `decrement`, `alias`, `group`, `assign-group` |
| `setup` | Agent session integration: `hooks`, `status`, `uninstall` |

Every command takes `--help` for a concise reference with its flags and examples.

### Dimensions

`top` accepts any of the API's breakdown columns, plus their plurals (`top countries`):

`referrer`, `referrer_name`, `referrer_type`, `utm_source`, `utm_medium`, `utm_campaign`,
`utm_term`, `utm_content`, `region`, `country`, `city`, `device`, `brand`, `model`,
`browser`, `browser_version`, `os`, `os_version`

### Windows

`--range` takes `30min`, `lastHour`, `last24h`, `today`, `yesterday`, `7d` (default), `30d`,
`3m`, `6m`, `12m`, `monthToDate`, `lastMonth`, `yearToDate`, `lastYear`. For anything else,
`--start` and `--end` take dates and override the range.

### Global flags

| Flag | Effect |
| --- | --- |
| `--project <id>` | Read a project other than `OPENPANEL_PROJECT_ID` |
| `--help` | Print the command reference; always allowed, never reported as unknown |

Flags must come **after** the command (`openpanel-axi pages --limit 25`, not
`openpanel-axi --limit 25 pages`).

## Behaviour worth relying on

- **Reads and writes use different credentials.** An agent given only a `read` client
  cannot write to the dataset it is analysing — OpenPanel's client types enforce that, not
  this tool.
- **`track event` is not idempotent, and says so.** Every run records another event. It is
  the only such command; `track identify` and `clients delete` are safe to repeat.
- **Never guesses the project.** Missing project id stops the command instead of returning
  an empty result set that reads as "no traffic".
- **`--fields` widens a row.** `sessions` carries 38 upstream columns and shows 9; `profiles`
  shows 4 of 11. `--fields utm_source,os` adds them back, and an unknown name lists every
  field the record actually has rather than being ignored.
- **Totals, not pages.** Lists report `count: N of M total`, and the help line names the flag
  that shows the rest.
- **Zero is stated.** An empty window says `0 sessions recorded in this window`, so an agent
  does not re-run with different flags to check.
- **Works on lagging self-hosted instances.** The core reads (`metrics`, `pages`, `top`,
  `events`, `live`) use routes present in every API generation. The 2.3-only commands
  (`funnel`, `flow`, `retention`, `profiles`, `sessions`, `gsc`, …) say so explicitly when an
  instance is too old, instead of failing obscurely.
- **Repeated filters go over as repeated parameters.** `--event a --event b` sends
  `event=a&event=b`; comma-joining them matches an event literally named `a,b` and returns
  zero rows.
- **Fails loud.** Unknown flags, ranges, and dimensions exit 2 and name the valid values
  inline, so the agent corrects in one turn instead of calling `--help`.
- **TOON output** on stdout, structured errors on stdout too, diagnostics on stderr.

## Development

```sh
npm install
npm test              # node:test, no framework, no network
npm run build:skill   # regenerate skills/openpanel-axi/SKILL.md from src/skill.js
npm run check:skill   # CI drift check
node bin/openpanel-axi.js --help
```

The tests stub `fetch` with a route table standing in for the OpenPanel API, so the suite
asserts the exact requests sent — and the ones that must not be sent. No credentials or
instance required.

See [AGENTS.md](AGENTS.md) for architecture and sharp-edge notes, [VISION.md](VISION.md) for
scope, and [CONTRIBUTING.md](CONTRIBUTING.md) for the release process.

## License

MIT
