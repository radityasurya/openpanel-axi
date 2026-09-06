# Vision

## The problem

OpenPanel has no CLI. It has an HTTP API and — on recent builds — an official MCP server
with roughly forty tools. For an agent, both are awkward for different reasons.

The MCP server costs tool-schema tokens on **every turn of every session**, whether or not
the conversation is about analytics, and it has to be registered per agent and per machine.
It is also served only by newer releases: a self-hosted instance a few months behind has no
`/mcp` endpoint at all.

The API is complete but unlabelled: two header credentials, three client types where the
one you already have is the wrong one, a named-window vocabulary (`monthToDate`,
`lastMonth`, …) that is not guessable, and two generations of routes with the same names.
So agents reach for `curl` and re-derive all of it every time.

## What openpanel-axi is

One agent-ergonomic surface over OpenPanel — the analytics read path first, plus the
project/client management and event-writing surfaces — following the ten
[AXI](https://axi.md) principles. Zero standing token cost: nothing loads until an agent
runs it, and what comes back is TOON projected down to the fields a decision needs.

It owns four things raw API calls do not:

1. **A project id that is never guessed.** Older releases answer an unknown project with an
   empty `200`. The tool refuses to send a request it cannot attribute.
2. **One surface across versions.** It targets the route generation that exists on both the
   cloud and a lagging self-hosted instance, so the same command works on both.
3. **Named windows, validated.** `--range` fails before the request with the valid values
   listed, instead of returning a default window that looks like the one you asked for.
4. **Errors that name the actual fix.** A write-only client, a dashboard URL mistaken for
   the API, and rate limiting are three different messages, not one `401`.

## Writes are separated, not forbidden

Reading and writing need different client types, so they read different environment
variables: `OPENPANEL_CLIENT_ID` for reads and management, `OPENPANEL_WRITE_CLIENT_ID` for
`track`. That is not ceremony — it means an agent handed only a `read` client **cannot**
write to the dataset it is analysing, even if it runs `track`. The separation is enforced by
OpenPanel's own client types, not by this tool's good intentions.

`track event` is the one non-idempotent command in the CLI, and it says so in its output
every time: re-running it does not verify anything, it records a second event.

## What it deliberately does not do

- **No project deletion.** Creating and editing a project is safe and reversible; deleting
  one soft-deletes it with a 24-hour grace period, and an agent should not hold that trigger.
  `clients delete` is the exception — a leaked secret needs revoking, and that is the command
  that does it.
- **No session replay upload.** The Track API accepts recording chunks; a CLI is the wrong
  shape for that.
- **No GSC setup.** Connecting Google Search Console is a Google OAuth flow. The CLI reads
  GSC data once a human has connected it, and says so when nothing is connected.
- **No credential minting from nothing.** `clients create` needs a `root` client you already
  have. This tool never logs in, refreshes, or writes a credential to disk.
- **No interactive anything.** Every operation completes from flags alone.

## Where it could go

- **A `compare` window**, since the metrics payload already supports a previous period —
  "sessions are down 20% week over week" is one call and the question actually being asked.
- **Saved reports and dashboards**, which the MCP server can execute and this cannot.
- **`--fields` on the wide nouns** (`sessions` carries 38 columns, `profiles` 11), so an
  agent can ask for a column the default projection drops.
