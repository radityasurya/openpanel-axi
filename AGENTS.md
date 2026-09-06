# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build,
test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## What this is

`openpanel-axi` is a direct client for the [OpenPanel](https://openpanel.dev) HTTP API, the
way `cloudflare-axi` is for Cloudflare's. OpenPanel ships no CLI, so there is nothing to
wrap: the tool owns auth (two headers), the window vocabulary, and the projection from
analytics payloads down to an agent-sized schema.

It **reads only**. There is a Track API for ingesting events and a Manage API for creating
projects and clients; neither belongs here. An agent that can write to an analytics project
can corrupt the numbers it is being asked to interpret.

## Toolchain differs from gh-axi deliberately

gh-axi is TypeScript + pnpm + vitest + eslint. This package is plain ESM JavaScript + npm +
`node:test`, with no build step and no transpile — same reasoning as `coolify-axi`: the AXI
contract is about the *interface* the agent sees, and a zero-build package keeps
`npx -y openpanel-axi` fast. Do not convert for symmetry alone.

## The project id must never be defaulted (`src/api.js#resolveProject`)

The tempting shortcut is to send a placeholder project id and let the server scope the
request to the client's own project. Current OpenPanel does exactly that for `read` clients
(`resolveClientProjectId` ignores the path param unless the client is `root`) — but the
release most self-hosted instances run reads `request.params.projectId` **straight off the
URL with no client scoping at all**. A placeholder there returns `200` with an empty result
set: not an error, just a project that appears to have no traffic.

So `resolveProject` raises when neither `--project` nor `OPENPANEL_PROJECT_ID` is set. A
wrong answer that looks like a right answer is the one failure mode this tool cannot ship.

## Target the legacy insights routes, not the new ones (`src/commands/insights.js`)

The API has two generations of analytics routes. Newer builds add `/overview`,
`/pages/top`, `/pages/performance`, `/traffic/*`, `/funnel`, `/retention`, and an `/mcp`
endpoint. The legacy set — `/metrics`, `/live`, `/pages`, and one route per column in
`overviewColumns` (`/country`, `/browser`, `/utm_source`, …) — exists in **both**
generations. Self-hosted instances lag the cloud by months, so the legacy set is the only
surface that works everywhere. Adding a newer route means it silently 404s for half the
users; if one is worth it, gate it and say so in the error.

**Probing an instance needs no credentials.** Both routers authenticate in a `preHandler`
hook, so an existing route answers `401` and a missing one answers `404`:

```sh
curl -so /dev/null -w '%{http_code}\n' https://openpanel.example.com/api/insights/x/metrics
```

That is how the route generation of a target instance was established, and how to check
before adding anything new.

## The default client cannot read (`src/api.js#apiError`)

Every OpenPanel project ships with a client, and that client is `write` type — Track API
only. Pointed at Insights or Export it returns `401 Invalid client credentials`, which reads
exactly like a typo in the secret and sends the user off checking the wrong thing. The 401
translation therefore leads with the client *type*, not the credential values.

## Insights takes the project in the path, Export takes it in the query

`/insights/:projectId/metrics` versus `/export/events?projectId=...`. Two conventions in one
API; `insights()` exists so the path form is written once, and `events` passes `projectId`
as a query parameter. Do not "unify" them — the server does not.

## `--project` is the analytics project, so setup scopes with `--repo`

`coolify-axi setup hooks --project` means "install into this repository". Here `--project`
is a global that selects the OpenPanel project, so the install-scope flag is `--repo`
instead. Keep them distinct: a boolean shadowing a global string flag parses, then means
something else.

## Repeated `--event` becomes a comma list (`src/commands/events.js`)

`/export/events` accepts `event` as a repeated parameter or an array, but the query builder
uses `URLSearchParams.set`, which keeps only the last value. Two `--event` flags would
silently filter on one name — a plausible-looking, wrongly-scoped result. They are joined
into a single comma-separated value instead.

## Dimension plurals are derived, never cross-mapped (`src/commands/insights.js`)

`top countries` resolves to `country` through a table derived from `DIMENSIONS`, so the two
cannot drift. An earlier version aliased `referrers` to `referrer_name`, which is what a
dashboard shows but *not* what the `referrer` column holds (the raw URL). Mapping a plural
onto a different column is guessing; AXI §6 says fail loud instead.

## Installable skill (`src/skill.js` → `skills/openpanel-axi/SKILL.md`)

The shipped skill stays a minimal stub and defers to the CLI for actual guidance. CLI output
(`openpanel-axi` dashboard, `--help`, `<command> --help`) is the single source of truth.
Regenerate with `npm run build:skill`; CI runs `npm run check:skill` and
`guard-generated-files.yml` blocks hand-edits under `skills/`.

## Testing without an OpenPanel instance

`tests/helpers.js` stubs `globalThis.fetch` with a path-keyed route table and returns the
call log, so tests assert the exact requests sent — and the ones that must not be sent. The
project-id test asserts `calls.length === 0`, which is the only way to catch a regression
that would otherwise look like a project with no traffic.

## Test discovery: `tests/`, not `test/`

`node --test` on Node 20 cannot expand a glob itself, so the script is a bare `node --test`
relying on default discovery — and default discovery treats *every* file under a directory
named `test` as a test file, which would run `helpers.js` as an empty passing test. Naming
the directory `tests` keeps `tests/*.test.js` matched by name and helpers out of the run.

## Release process

Releases are cut by release-please from conventional commits on `main`; merging the bot's
release PR triggers `npm publish` via `.github/workflows/release-please.yml`. Do not
hand-edit `CHANGELOG.md` or `.release-please-manifest.json` — a guard workflow blocks PRs
that touch them.

Publishing uses **npm trusted publishing (OIDC)**, not a stored token: the workflow's
`id-token: write` permission lets npm verify the workflow's identity, so there is no
`NPM_TOKEN` to rotate or leak, and provenance is attested automatically. The trust
relationship is registered once, against the **workflow filename**:

```sh
npm trust github openpanel-axi --repo radityasurya/openpanel-axi --file release-please.yml --allow-publish
```

Renaming `release-please.yml` breaks publishing until it is re-registered.

## Writes take a different client than reads (`src/api.js#credentials`)

`read` clients cannot write and `write` clients cannot read — the same credential cannot do
both unless it is `root`. So `track` resolves `OPENPANEL_WRITE_CLIENT_ID` first and falls
back to the main pair (correct when that one is `root`, loudly refused when it is `read`).
Do not "simplify" this to one credential pair: the split is what stops an agent handed a
read client from writing into the dataset it is analysing.

The 401 translation branches on the path for the same reason — `/track`, `/manage`, and the
read surfaces each need a *different* client type, and a generic "check your credentials"
sends the user off verifying a secret that was never wrong.

## `clients create` must not inherit the API's default type

`zCreateClient` defaults `type` to **`write`**. A client created without an explicit type is
therefore the one type that cannot read analytics — which is exactly the trap that makes
`401 Invalid client credentials` so confusing in the first place. `clients create` defaults
to `read` and rejects anything outside `read|write|root`. Asserted in `tests/write.test.js`.

## `track event` is the one non-idempotent command

Every other command in this CLI can be re-run freely. `track event` cannot: each run appends
another event, permanently, to the numbers the tool exists to interpret. Its output says so
on every success, and its `--help` leads with it. If a "did it work?" check is ever added,
it must read via `events --event <name>` — never re-send.

`track` also rejects `--project`. The event lands in the project its write client belongs to,
so accepting a project selector would imply targeting the command does not have.

## `/track` answers 200 with no body (`src/api.js#op`)

Every other route returns JSON, so an unparseable body is the signal that `OPENPANEL_API_URL`
points at the dashboard rather than the API — that error message is load-bearing. `/track` is
the exception, so it passes `allowEmpty: true` rather than the parse check being relaxed
globally.

## Instance version and the 2.3 upgrade (2026-09-06)

The self-hosted reference instance ran **2.2.1** (image `lindesvard/openpanel-api:2`, built
2026-03-21) and was upgraded to **2.3.0** by re-pulling the mutable `:2` tag and redeploying.
The api container runs `CI=true pnpm -r run migrate:deploy` on start, so ten Prisma
migrations applied automatically; ClickHouse needed nothing. After the upgrade `/overview`,
`/pages/top`, `/traffic/*`, `/funnel`, and `/mcp` all exist.

This does not change the rule above: the CLI still targets the legacy routes, because the
next self-hosted instance it meets will not have been upgraded.

## `/export/events` omits `device` and `referrer` unless asked (`src/commands/events.js`)

The export payload carries `country`, `city`, `browser`, and `os` by default, but `device`
and `referrer` come back **null** unless they are named in the `includes` query parameter.
The default projection printed `-` for both, which reads as "no device recorded" rather than
"not requested" — a plausible-looking wrong answer. `events` now always sends
`includes=device,referrer`. Verified against a live instance, not inferred.

## An empty referrer means direct traffic, not an unknown source

`nullIf(column, '')` turns empty dimension values into `null`, and a generic `(none)` label
is right for `country` or `browser`. It is wrong for the `referrer*` columns: an empty
referrer is a visit that had no referrer, i.e. direct. On the reference project that is 30 of
42 sessions — labelling the largest traffic source "(none)" would have an agent reporting the
majority of traffic as unidentified. `label(value, empty)` takes the caption, and
`isReferrer()` decides it.

## Round the metrics payload once, in `api.js` (`metricValue`)

ClickHouse returns `avg_session_duration` as `962.0422199999999`. Sub-second precision on a
session average is not information, it is tokens. The rounding lives in `api.js` because
**two** call sites render that payload — the `metrics` command and the no-args dashboard —
and the first fix only patched the command, leaving the dashboard printing raw floats.
Anything that formats a metric belongs there, not in a caller.

## Array query values must repeat, never comma-join (`src/api.js#op`)

`URLSearchParams.set` with an array stringifies it to `a,b`. Both `/export/events?event=` and
`/insights/:id/funnel?steps=` take repeated parameters, and a comma-joined value is read as
**one** value literally named `a,b`:

```
?event=screen_view&event=link_out  -> 222 events
?event=screen_view,link_out        -> 0 events, HTTP 200
```

Zero rows with a success status is the worst failure this tool can produce, and it shipped
in 0.1.0 behind a test that asserted the comma behaviour. `op` now appends array values, and
`tests/helpers.js` records `queryAll` so a test can assert the repetition rather than the
collapsed last value.

## The two APIs disagree on the event-name parameter

`/export/events` takes `event`; `/insights/:id/events/properties` and `property_values` take
`eventName` and `propertyKey`. Same concept, different spellings, same tool. Check the route
before adding a filter — a wrong key is silently ignored and the result looks unfiltered.

## A failing status can carry a non-JSON body (`src/api.js#op`)

The `/gsc/*` routes answer a missing Search Console connection with a **plain-text**
`500 Internal server error`. Parsing the body before checking the status reported "OpenPanel
returned a non-JSON response", which sends the reader after `OPENPANEL_API_URL` instead of
the missing integration. Status first, then parse: a non-JSON body on a failing response is
still that failure.

## Version gating is a message, not a feature flag (`src/api.js#MODERN`)

Funnels, flow, retention, engagement, profiles, sessions, page performance, and GSC exist
only from 2.3. Rather than probing the version, a 404 on one of those paths appends "this
route needs OpenPanel 2.3 or newer" to the existing NOT_FOUND. The core reads stay on the
legacy routes so they keep working on an older instance — see the rule above about which
generation to target.

## `assign_group` does not backfill events

Linking a profile to a group affects nothing that was already recorded, and nothing recorded
later either: `track event` must carry `--group` explicitly. The command says so in its
output, because the natural assumption is the opposite.

## `range=` is unusable on the gsc routes (`src/commands/gsc.js`)

The GSC ClickHouse table stores `date` as a **`Date`**, but `resolveDates()` hands the query a
full datetime derived from `range=`, and ClickHouse refuses the comparison:

```
Cannot convert string '2026-08-07 00:00:00' to type Date:
  while executing greaterOrEquals on __table1.date Date, '2026-08-07 00:00:00'_String
```

Every `/insights/:projectId/gsc/*` route 500s for any named range. Passing explicit date-only
`startDate`/`endDate` skips the derivation and works. This is an upstream bug — the dashboard
is unaffected because it reaches GSC over tRPC, which takes a different path — so `gsc`
commands compute their own date-only bounds and never forward `range`.

Their window also ends `LAG_DAYS` back, for the same reason `gsc-axi` does: Search Console
finalises on a 2-3 day delay and a window ending today shows a decline that is not real.

## `/gsc/overview` wraps its rows in `data`

Every other gsc route returns a bare array. `overview` returns `{ summary, data }`, and its
summary uses different field names again (`total_clicks`, `avg_ctr` as a **percentage**, while
per-row `ctr` is a **fraction**). Three shapes in one route group; check before projecting.

## A 500 on gsc is not proof of a missing connection

The original translation said "GSC is probably not connected", which was right until GSC was
connected and the date bug produced the same 500. The error text stays useful, but the empty
*result* help no longer suggests connecting — a project with no connection raises, so an empty
list means an empty window.

## Detail routes return a 91-row series nobody asked for (`src/commands/gsc.js`)

`/gsc/pages/details` and `/gsc/queries/details` each answer with `timeseries` (one row per
day in the window, overwhelmingly zeros) plus the rows that actually answer the question.
Passing the payload straight through cost 2393 characters for a page with two queries and two
clicks. `detail()` sums the series into totals, prints the breakdown, and names the series
with its row count behind `--series` — 354 characters for the same call.

When averaging position, skip days where `position` is 0: those are days the page never
ranked at all, and counting them drags the average toward a better number than the page held.

## AXI §10's version guard is a ratio, not a millisecond budget (`tests/version.test.js`)

The test measures `node -e "console.log(1)"` and `--version` in the same process and asserts
the ratio stays under 1.5x. Measured here: fast path 1.08x, graph load 1.81x — so a static
`import` of `src/cli.js` in `bin/` fails it. An absolute budget would go flaky across machines.

## Verified against a live 2.3 instance (2026-09-06)

Every read command in this CLI has been run against a real self-hosted OpenPanel with real
traffic, and the response shapes here were captured from that instance rather than inferred
from the service code. The write path was verified with a `clients create` → `clients delete`
round-trip, which exercises POST and DELETE without writing anything into the analytics data
the tool exists to interpret. Do not verify `track` against a project whose numbers matter.

## `--fields` is additive, and unknown names are fatal (`src/api.js#extraFields`)

AXI §2 asks for a `--fields` escape hatch on wide nouns. Two decisions worth keeping:

It **adds** to the default projection rather than replacing it, so a row an agent already
knows how to read keeps its shape and the flag cannot accidentally remove the identifier.

An unknown field name **raises**, listing every key the raw record carries. Silently ignoring
it would hand back a row that looks filtered but is not — the same class of failure as the
comma-joined `event` parameter. The available list comes from the payload itself, so it stays
correct when upstream adds a column.
