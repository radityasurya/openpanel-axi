import { AxiError } from "axi-sdk-js";
import {
  DATE_FLAGS,
  DIMENSIONS,
  dateFlagHelp,
  dateWindow,
  insights,
  label,
  resolveProject,
} from "../api.js";
import { BIN, helpFor, parse, positiveInt, required, wantsHelp } from "../args.js";

const DEFAULT_LIMIT = 10;

// The metrics payload is already an agent-sized rollup; revenue is only
// meaningful on projects that track it, so it stays out unless non-zero.
const METRIC_FIELDS = [
  "unique_visitors",
  "total_sessions",
  "total_screen_views",
  "views_per_session",
  "bounce_rate",
  "avg_session_duration",
];

const HELP = {
  metrics: helpFor({
    command: "metrics",
    description: "Visitors, sessions, pageviews, bounce rate, and session duration for a window",
    usage: `${BIN} metrics [--range <window>] [--start <date> --end <date>] [--series]`,
    flags: { ...dateFlagHelp(), "--series": "Include the per-interval time series" },
    examples: [`${BIN} metrics`, `${BIN} metrics --range 30d`, `${BIN} metrics --range today --series`],
  }),
  live: helpFor({
    command: "live",
    description: "Visitors active on the site right now",
    usage: `${BIN} live`,
    examples: [`${BIN} live`],
  }),
  pages: helpFor({
    command: "pages",
    description: "Top pages by sessions",
    usage: `${BIN} pages [--range <window>] [--limit <n>]`,
    flags: { ...dateFlagHelp(), "--limit": `Rows to show (default ${DEFAULT_LIMIT})` },
    examples: [`${BIN} pages`, `${BIN} pages --range 30d --limit 25`],
  }),
  top: helpFor({
    command: "top",
    description: "Top values for one traffic dimension (referrer, country, device, utm_*, ...)",
    usage: `${BIN} top <dimension> [--range <window>] [--limit <n>]`,
    flags: { ...dateFlagHelp(), "--limit": `Rows to show (default ${DEFAULT_LIMIT})` },
    examples: [`${BIN} top referrer_name`, `${BIN} top country --range 30d`, `${BIN} top utm_campaign`],
  }),
};

/** `metrics.avg_session_duration` is seconds; the rest are counts or percents. */
function metricRow(metrics = {}) {
  const row = Object.fromEntries(
    METRIC_FIELDS.filter((field) => metrics[field] !== undefined).map((field) => [
      field,
      metrics[field],
    ]),
  );
  if (metrics.total_revenue) row.total_revenue = metrics.total_revenue;
  return row;
}

/** A daily bucket prints as a date; anything finer keeps its timestamp. */
function stamp(date) {
  const text = String(date ?? "");
  return text.endsWith("T00:00:00.000Z") ? text.slice(0, 10) : text.replace(".000Z", "Z");
}

export async function metricsCommand(argv) {
  if (wantsHelp(argv)) return HELP.metrics;
  const { values } = parse(argv, {
    command: "metrics",
    flags: { ...DATE_FLAGS, series: { type: "boolean" } },
  });
  const project = resolveProject(values.project);
  const query = dateWindow(values);
  const payload = await insights(project, "/metrics", { query });
  const metrics = metricRow(payload?.metrics);

  if (!metrics.total_sessions) {
    return {
      window: query.startDate ? `${query.startDate}..${query.endDate ?? "now"}` : query.range,
      metrics: "0 sessions recorded in this window",
      help: [
        `Run \`${BIN} metrics --range 30d\` for a wider window`,
        `Run \`${BIN} live\` to check the project is receiving traffic at all`,
      ],
    };
  }

  return {
    window: query.startDate ? `${query.startDate}..${query.endDate ?? "now"}` : query.range,
    metrics,
    ...(values.series
      ? {
          series: (payload.series ?? []).map((point) => ({
            date: stamp(point.date),
            unique_visitors: point.unique_visitors,
            total_sessions: point.total_sessions,
            total_screen_views: point.total_screen_views,
          })),
        }
      : {}),
    help: [
      `Run \`${BIN} pages\` for the pages behind these sessions`,
      `Run \`${BIN} top referrer_name\` for where the traffic came from`,
      ...(values.series ? [] : [`Run \`${BIN} metrics --series\` for the per-interval breakdown`]),
    ],
  };
}

export async function liveCommand(argv) {
  if (wantsHelp(argv)) return HELP.live;
  const { values } = parse(argv, { command: "live" });
  const project = resolveProject(values.project);
  const payload = await insights(project, "/live", {});
  const visitors = payload?.visitors ?? 0;
  return visitors === 0
    ? { live: "0 visitors active right now", help: [`Run \`${BIN} metrics\` for the last 7 days`] }
    : { live: `${visitors} visitors active right now` };
}

export async function pagesCommand(argv) {
  if (wantsHelp(argv)) return HELP.pages;
  const { values } = parse(argv, {
    command: "pages",
    flags: { ...DATE_FLAGS, limit: { type: "string" } },
  });
  const project = resolveProject(values.project);
  const limit = positiveInt(values.limit, "--limit", DEFAULT_LIMIT);
  const query = dateWindow(values);
  const rows = await insights(project, "/pages", { query });
  const all = Array.isArray(rows) ? rows : [];

  if (all.length === 0) {
    return {
      window: query.range,
      pages: `0 pages received traffic in this window`,
      help: [`Run \`${BIN} pages --range 30d\` for a wider window`],
    };
  }

  // Path alone is ambiguous when a project tracks several domains.
  const multiOrigin = new Set(all.map((row) => row.origin)).size > 1;
  const shown = all.slice(0, limit);
  return {
    window: query.range,
    count: `${shown.length} of ${all.length} total`,
    pages: shown.map((row) => ({
      ...(multiOrigin ? { origin: row.origin } : {}),
      path: label(row.path),
      sessions: row.sessions,
      pageviews: row.pageviews,
    })),
    help: [
      ...(shown.length < all.length ? [`Run \`${BIN} pages --limit ${all.length}\` for all of them`] : []),
      `Run \`${BIN} top referrer_name\` for where these visits came from`,
    ],
  };
}

// The plural of each column, so `top countries` works. Deriving it from
// DIMENSIONS keeps the two in sync and never maps a plural onto a *different*
// column — `referrers` is the raw referrer URL, not referrer_name.
const PLURALS = new Map(
  DIMENSIONS.map((name) => [name.endsWith("y") ? `${name.slice(0, -1)}ies` : `${name}s`, name]),
);

/** Accept the plural an agent is likely to type, but never guess between columns. */
function resolveDimension(input) {
  const wanted = String(input).toLowerCase();
  if (DIMENSIONS.includes(wanted)) return wanted;
  const singular = PLURALS.get(wanted);
  if (singular) return singular;
  throw new AxiError(`unknown dimension ${input}`, "VALIDATION_ERROR", [
    `valid dimensions: ${DIMENSIONS.join(", ")}`,
    `Run \`${BIN} pages\` for pages, which are not a dimension`,
  ]);
}

export async function topCommand(argv) {
  if (wantsHelp(argv)) return HELP.top;
  const { values, positionals } = parse(argv, {
    command: "top",
    flags: { ...DATE_FLAGS, limit: { type: "string" } },
  });
  const selector = required(positionals[0], "<dimension>", "top", `${BIN} top referrer_name`);
  const dimension = resolveDimension(selector);
  const project = resolveProject(values.project);
  const limit = positiveInt(values.limit, "--limit", DEFAULT_LIMIT);
  const query = dateWindow(values);
  const rows = await insights(project, `/${dimension}`, { query });
  const all = Array.isArray(rows) ? rows : [];

  if (all.length === 0) {
    return {
      window: query.range,
      [dimension]: `0 values recorded for ${dimension} in this window`,
      help: [`Run \`${BIN} top ${dimension} --range 30d\` for a wider window`],
    };
  }

  const shown = all.slice(0, limit);
  return {
    window: query.range,
    dimension,
    count: `${shown.length} of ${all.length} total`,
    values: shown.map((row) => ({
      name: label(row.name),
      sessions: row.sessions,
      pageviews: row.pageviews,
    })),
    help: [
      ...(shown.length < all.length
        ? [`Run \`${BIN} top ${dimension} --limit ${all.length}\` for all of them`]
        : []),
      `Run \`${BIN} top <dimension>\` for another of: ${DIMENSIONS.join(", ")}`,
    ],
  };
}
