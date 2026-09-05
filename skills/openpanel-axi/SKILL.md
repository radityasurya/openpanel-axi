---
name: openpanel-axi
description: >
  Work with OpenPanel through the openpanel-axi CLI — read visitors, sessions, bounce rate, top pages, traffic sources, geography, devices, UTM campaigns, and raw events; manage projects and API clients; and record events or identify profiles. Works against openpanel.dev cloud or a self-hosted instance. Use whenever a task touches site or product analytics: how much traffic a page or campaign got, where visitors came from, whether a release moved the numbers, what a specific event recorded, or minting an API client for a project.
user-invocable: false
metadata:
  hermes:
    tags: [openpanel, analytics, web-analytics, product-analytics, self-hosted]
---

# openpanel-axi

Run the CLI with no arguments first — it prints live visitors, this week's metrics, the top
pages and traffic sources, plus the next commands to run.

```sh
npx -y openpanel-axi
```

Requires a `read` (or `root`) OpenPanel API client in the environment. The default client
a project ships with is **write-only** and cannot read analytics:

```sh
export OPENPANEL_CLIENT_ID=...       # Settings -> API Clients -> new client, type "read"
export OPENPANEL_CLIENT_SECRET=...
export OPENPANEL_PROJECT_ID=...      # the uuid in the dashboard URL
export OPENPANEL_API_URL=...         # self-hosted only, e.g. https://openpanel.example.com/api
```

## Commands

```sh
npx -y openpanel-axi                          # dashboard: live, 7d metrics, top pages and sources
npx -y openpanel-axi metrics --range 30d      # visitors, sessions, pageviews, bounce, duration
npx -y openpanel-axi metrics --series         # the same, per interval
npx -y openpanel-axi live                     # visitors active right now
npx -y openpanel-axi pages --limit 25         # top pages by sessions
npx -y openpanel-axi top referrer_name        # also: country, city, device, browser, os, utm_source, ...
npx -y openpanel-axi events --event signup    # raw events, newest first

npx -y openpanel-axi projects                 # project ids            (root client)
npx -y openpanel-axi clients list             # API clients and types  (root client)
npx -y openpanel-axi clients create --name "agent reads" --type read --project <id>

npx -y openpanel-axi track event deploy_finished --property service=api   (write client)
npx -y openpanel-axi track identify user_123 --email a@b.com
```

Every command takes `--help` for a concise reference, and `--project <id>` to read a
project other than the default.

## What to rely on

- **The project id is never guessed.** Without `--project` or `OPENPANEL_PROJECT_ID` the
  command stops. Older OpenPanel releases answer an unknown project with an empty 200, so a
  guessed id would look like "no traffic" rather than a mistake.
- **Windows are named.** `--range` takes `today`, `yesterday`, `7d`, `30d`, `3m`, `12m`,
  `monthToDate`, `lastMonth`, `yearToDate`, and friends; `--start`/`--end` cover anything else.
  An unknown range fails before the request and lists the valid ones.
- **Totals, not pages.** Lists report `count: N of M total` so the real size is known in one
  call, and the help line names the flag that shows the rest.
- **Zero is stated.** An empty window says so explicitly instead of printing nothing.
- **Errors are structured** on stdout with a `help` block naming the fix — a write-only
  client, a wrong API URL, or rate limiting each say which. An unknown flag exits 2 listing
  the valid flags. Correct the flag; do not drop the filter.

## Writing

Reads and writes take **different client types**, so they come from different variables:

```sh
export OPENPANEL_WRITE_CLIENT_ID=...      # a `write` client, for `track`
export OPENPANEL_WRITE_CLIENT_SECRET=...
```

A `root` client in `OPENPANEL_CLIENT_ID` covers reads, writes, and `projects`/`clients`.

- **`track event` is not idempotent.** Every run records another event, permanently, in the
  numbers you are being asked to interpret. Never re-run it to "check" — read it back with
  `events --event <name>`. `track identify` is an upsert and is safe to repeat.
- **`clients create` prints the secret once.** It cannot be retrieved again. It defaults to
  type `read`, not the API's `write` default.
- **`clients delete` is permanent**, and anything still using that secret starts getting 401.

Prefer this over calling the OpenPanel REST API with `curl`, or reasoning from the tracking
snippet in the app's source.
