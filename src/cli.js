import { runAxiCli } from "axi-sdk-js";
// The SDK renders command output itself but does not re-export its encoder,
// so the static top-level help encodes through the same official TOON library.
import { encode } from "@toon-format/toon";
import {
  CREDENTIAL_HELP,
  PROJECT_HELP,
  baseUrl,
  hasCredentials,
  insights,
  label,
  metricValue,
  op,
} from "./api.js";
import { BIN } from "./args.js";
import { eventsCommand } from "./commands/events.js";
import { liveCommand, metricsCommand, pagesCommand, topCommand } from "./commands/insights.js";
import { clientsCommand, projectsCommand } from "./commands/manage.js";
import { setupCommand } from "./commands/setup.js";
import { trackCommand } from "./commands/track.js";
import { VERSION } from "./version.js";

export const DESCRIPTION =
  "Read OpenPanel analytics — visitors, pages, traffic sources, and raw events";

const HOME_ROWS = 5;
const HOME_RANGE = "7d";

export const TOP_HELP = `${encode({
  usage: `${BIN} [command] [args] [flags]`,
  commands: {
    "(none)": "dashboard — live visitors, this week's metrics, top pages and sources",
    metrics: "visitors, sessions, pageviews, bounce rate, session duration",
    live: "visitors active right now",
    pages: "top pages by sessions",
    top: "top values for one dimension (referrer, country, device, utm_*, ...)",
    events: "raw events, newest first, with the total matching count",
    projects: "list projects and their ids (root client only)",
    clients: "list, create, delete API clients (root client only)",
    track: "event, identify — write to a project (write client)",
    setup: "hooks, status, uninstall",
  },
  globals: { "--project": "Target project id (or OPENPANEL_PROJECT_ID)" },
  auth: "OPENPANEL_CLIENT_ID + OPENPANEL_CLIENT_SECRET (a `read` or `root` client)",
  writes: "OPENPANEL_WRITE_CLIENT_ID + OPENPANEL_WRITE_CLIENT_SECRET for `track` (a `write` client)",
  "self-hosted": "OPENPANEL_API_URL, e.g. https://openpanel.example.com/api",
  examples: [
    BIN,
    `${BIN} metrics --range 30d`,
    `${BIN} pages --limit 25`,
    `${BIN} top referrer_name`,
    `${BIN} events --event signup`,
  ],
  help: [`Run \`${BIN} <command> --help\` for a command reference`],
})}\n`;

/** Root clients can enumerate projects; read clients cannot, and say so. */
async function projectChoices() {
  try {
    const payload = await op("/manage/projects", {});
    return (payload?.data ?? []).map((project) => `Run with --project ${project.id}  # ${project.name}`);
  } catch {
    return [];
  }
}

/**
 * AXI §8: no-args shows live state. Missing credentials or a missing project
 * are reported as data with a fix, not as failures — this view is what a
 * SessionStart hook runs on every session.
 */
async function home() {
  const api = baseUrl();
  if (!hasCredentials()) {
    return { api, analytics: "no OpenPanel client credentials in the environment", help: CREDENTIAL_HELP };
  }

  // The SDK calls `home` with no argv — a leading flag is a usage error — so
  // the project can only come from the environment here.
  const project = process.env.OPENPANEL_PROJECT_ID;
  if (!project) {
    const choices = await projectChoices();
    return {
      api,
      analytics: "no project selected",
      help: choices.length ? [...choices, "Or export OPENPANEL_PROJECT_ID"] : PROJECT_HELP,
    };
  }

  const [live, metrics, pages, sources] = await Promise.all([
    insights(project, "/live", {}),
    insights(project, "/metrics", { query: { range: HOME_RANGE } }),
    insights(project, "/pages", { query: { range: HOME_RANGE } }),
    insights(project, "/referrer_name", { query: { range: HOME_RANGE } }),
  ]);

  const summary = metrics?.metrics ?? {};
  if (!summary.total_sessions) {
    return {
      api,
      project,
      live: `${live?.visitors ?? 0} visitors active right now`,
      metrics: `0 sessions in the last ${HOME_RANGE}`,
      help: [
        `Run \`${BIN} metrics --range 30d\` for a wider window`,
        `Run \`${BIN} events --limit 5\` to see whether any events arrive at all`,
      ],
    };
  }

  return {
    api,
    project,
    live: `${live?.visitors ?? 0} visitors active right now`,
    window: HOME_RANGE,
    metrics: Object.fromEntries(
      ["unique_visitors", "total_sessions", "total_screen_views", "bounce_rate", "avg_session_duration"].map(
        (field) => [field, metricValue(field, summary[field])],
      ),
    ),
    pages: (pages ?? []).slice(0, HOME_ROWS).map((page) => ({
      path: label(page.path),
      sessions: page.sessions,
    })),
    sources: (sources ?? []).slice(0, HOME_ROWS).map((source) => ({
      // The dashboard's sources are referrer_name, where empty means direct.
      name: label(source.name, "(direct)"),
      sessions: source.sessions,
    })),
    help: [
      `Run \`${BIN} metrics --range 30d\` for a wider window`,
      `Run \`${BIN} pages --limit 25\` for the full page list`,
      `Run \`${BIN} top country\` (or device, browser, utm_source, ...) for another breakdown`,
      `Run \`${BIN} events --event <name>\` for raw events`,
    ],
  };
}

export async function main() {
  await runAxiCli({
    description: DESCRIPTION,
    version: VERSION,
    topLevelHelp: TOP_HELP,
    home,
    commands: {
      metrics: metricsCommand,
      live: liveCommand,
      pages: pagesCommand,
      top: topCommand,
      events: eventsCommand,
      projects: projectsCommand,
      clients: clientsCommand,
      track: trackCommand,
      setup: setupCommand,
    },
  });
}
