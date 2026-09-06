import { AxiError } from "axi-sdk-js";
import { DATE_FLAGS, insights, resolveProject } from "../api.js";
import { BIN, helpFor, makeDispatcher, parse, positiveInt, required, wantsHelp } from "../args.js";

const DEFAULT_LIMIT = 20;

// The GSC ClickHouse table stores `date` as a `Date`, but the server derives a
// full datetime from `range=` and ClickHouse refuses to compare the two:
//   Cannot convert string '2026-08-07 00:00:00' to type Date
// Sending explicit date-only bounds skips that derivation entirely. Verified
// against a live 2.3 instance — `range=` 500s, `startDate=`/`endDate=` works.
const GSC_RANGES = { "7d": 7, "28d": 28, "30d": 30, "90d": 90, "3m": 90, "6m": 180, "12m": 365, "16m": 480 };

// Search Console finalises data on a 2-3 day delay, so a window ending today
// always shows the last rows near zero — a decline that is not real.
const LAG_DAYS = 2;

function day(offset) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10);
}

/** Date-only bounds; `range` is never forwarded to a gsc route. */
function gscWindow(values = {}) {
  if (values.start || values.end) {
    return {
      startDate: values.start ?? day(GSC_RANGES["28d"] + LAG_DAYS),
      endDate: values.end ?? day(LAG_DAYS),
    };
  }
  const range = values.range ?? "28d";
  const days = GSC_RANGES[range];
  if (days === undefined) {
    throw new AxiError(`unknown --range ${range} for gsc`, "VALIDATION_ERROR", [
      `valid ranges: ${Object.keys(GSC_RANGES).join(", ")}`,
      "Or pass explicit bounds with --start <YYYY-MM-DD> --end <YYYY-MM-DD>",
    ]);
  }
  return { startDate: day(days + LAG_DAYS), endDate: day(LAG_DAYS) };
}

function gscFlagHelp() {
  return {
    "--range": `Named window (default 28d): ${Object.keys(GSC_RANGES).join(", ")}`,
    "--start": "Window start as YYYY-MM-DD (overrides --range)",
    "--end": "Window end as YYYY-MM-DD",
  };
}

function label(dates) {
  return `${dates.startDate}..${dates.endDate}`;
}

const NOT_CONNECTED = [
  "Connect Google Search Console in the dashboard under the project's settings",
  "It is a Google OAuth flow and cannot be done from this CLI",
];

const HELP = {
  overview: helpFor({
    command: "gsc overview",
    description: "Search performance over time: clicks, impressions, CTR, average position",
    usage: `${BIN} gsc overview [--range <window>] [--interval day|week|month]`,
    flags: { ...gscFlagHelp(), "--interval": "Bucket size (default day)" },
    examples: [`${BIN} gsc overview --range 30d`],
  }),
  pages: helpFor({
    command: "gsc pages",
    description: "Top pages in Google search, ranked by clicks",
    usage: `${BIN} gsc pages [--limit <n>] [--range <window>]`,
    flags: { ...gscFlagHelp(), "--limit": `Rows to show (default ${DEFAULT_LIMIT})` },
    examples: [`${BIN} gsc pages --range 30d`],
  }),
  queries: helpFor({
    command: "gsc queries",
    description: "Top search queries, ranked by clicks",
    usage: `${BIN} gsc queries [--limit <n>] [--range <window>]`,
    flags: { ...gscFlagHelp(), "--limit": `Rows to show (default ${DEFAULT_LIMIT})` },
    examples: [`${BIN} gsc queries`],
  }),
  page: helpFor({
    command: "gsc page",
    description: "One page's search performance, with the queries driving it",
    usage: `${BIN} gsc page <url> [--range <window>] [--series]`,
    flags: { ...gscFlagHelp(), "--series": "Include the per-day series (91 rows on a 90d window)" },
    examples: [`${BIN} gsc page https://example.com/blog/post`],
  }),
  query: helpFor({
    command: "gsc query",
    description: "One search query, with the pages that rank for it",
    usage: `${BIN} gsc query "<text>" [--range <window>] [--series]`,
    flags: { ...gscFlagHelp(), "--series": "Include the per-day series (91 rows on a 90d window)" },
    examples: [`${BIN} gsc query "openpanel self hosted"`],
  }),
  opportunities: helpFor({
    command: "gsc opportunities",
    description: "Queries ranking 4-20 with real volume — the cheapest SEO wins",
    usage: `${BIN} gsc opportunities [--min-impressions <n>] [--range <window>]`,
    flags: { ...gscFlagHelp(), "--min-impressions": "Volume floor (default 50)" },
    examples: [`${BIN} gsc opportunities --range 30d`],
  }),
  cannibalization: helpFor({
    command: "gsc cannibalization",
    description: "Queries where several of your pages compete against each other",
    usage: `${BIN} gsc cannibalization [--range <window>]`,
    examples: [`${BIN} gsc cannibalization`],
  }),
};

/** GSC rows are clicks/impressions/ctr/position under varying key names. */
function searchRow(row) {
  const projected = {};
  for (const [key, value] of Object.entries(row)) {
    const known = ["date", "clicks", "impressions", "ctr", "position", "page", "query", "url"];
    const summary = ["total_clicks", "total_impressions", "avg_ctr", "avg_position"];
    if (!known.includes(key) && !summary.includes(key)) continue;
    if (key === "avg_ctr") {
      // Already a percentage in the summary, unlike the per-row fractional ctr.
      projected.avg_ctr = `${Number(value ?? 0).toFixed(2)}%`;
      continue;
    }
    if (key === "avg_position") {
      projected.avg_position = Number((value ?? 0).toFixed(1));
      continue;
    }
    // ctr arrives as a fraction (0.1111111119389534) and position with full
    // float noise (18.55555534362793); neither is readable as returned.
    if (key === "ctr") projected.ctr = `${((value ?? 0) * 100).toFixed(1)}%`;
    else if (key === "position") projected.position = Number((value ?? 0).toFixed(1));
    else projected[key] = value;
  }
  return Object.keys(projected).length ? projected : row;
}

function empty(what, range) {
  return {
    window: range,
    [what]: `0 ${what} reported by Search Console in this window`,
    // A project with no GSC connection errors rather than returning nothing, so
    // an empty result here means the window is empty — not that setup is missing.
    help: ["Search Console data lags by 2-3 days; try a wider --range"],
  };
}

function listing(name, path, extraFlags = {}, buildQuery = () => ({})) {
  return async function run(argv) {
    if (wantsHelp(argv)) return HELP[name];
    const { values } = parse(argv, {
      command: `gsc ${name}`,
      flags: { ...DATE_FLAGS, limit: { type: "string" }, ...extraFlags },
    });
    const dates = gscWindow(values);
    const payload = await insights(resolveProject(values.project), path, {
      query: { ...dates, limit: positiveInt(values.limit, "--limit", DEFAULT_LIMIT), ...buildQuery(values) },
    });
    const rows = Array.isArray(payload) ? payload : (payload?.data ?? payload?.rows ?? []);
    if (!Array.isArray(rows) || rows.length === 0) return empty(name, label(dates));
    return {
      window: label(dates),
      count: `${rows.length} shown`,
      [name]: rows.map(searchRow),
    };
  };
}

async function overview(argv) {
  if (wantsHelp(argv)) return HELP.overview;
  const { values } = parse(argv, {
    command: "gsc overview",
    flags: { ...DATE_FLAGS, interval: { type: "string" } },
  });
  const dates = gscWindow(values);
  const payload = await insights(resolveProject(values.project), "/gsc/overview", {
    query: { ...dates, interval: values.interval ?? "day" },
  });
  // `/gsc/overview` wraps its rows in `data`, unlike the other gsc routes.
  const series = payload?.data ?? payload?.series ?? (Array.isArray(payload) ? payload : []);
  if (series.length === 0) return empty("overview", label(dates));
  return {
    window: label(dates),
    ...(payload?.summary ? { summary: searchRow(payload.summary) } : {}),
    count: `${series.length} points`,
    series: series.map((point) => searchRow(point)),
  };
}

/**
 * Both detail routes answer with a 91-row per-day series plus the rows that
 * matter. The series is almost entirely zeros and answers no question on its
 * own, so it is summed into totals and named with its size rather than dumped
 * (AXI §2, §4); `--series` is the escape hatch (§3).
 */
function detail(payload, breakdown, key, values, dates) {
  const series = payload?.timeseries ?? [];
  const rows = payload?.[breakdown] ?? [];
  const sum = (field) => series.reduce((total, point) => total + (point[field] ?? 0), 0);
  const clicks = sum("clicks");
  const impressions = sum("impressions");
  const ranked = series.filter((point) => (point.position ?? 0) > 0);

  return {
    window: label(dates),
    totals: {
      clicks,
      impressions,
      ctr: `${impressions ? ((clicks / impressions) * 100).toFixed(1) : "0.0"}%`,
      avg_position: ranked.length
        ? Number((ranked.reduce((total, point) => total + point.position, 0) / ranked.length).toFixed(1))
        : 0,
    },
    ...(rows.length
      ? { [breakdown]: rows.map(searchRow) }
      : { [breakdown]: `0 ${breakdown} recorded in this window` }),
    ...(values.series
      ? { series: series.map(searchRow) }
      : {
          series: `${series.length} daily points not shown`,
          help: [`Run the same command with --series for the per-day breakdown`],
        }),
  };
}

async function pageDetails(argv) {
  if (wantsHelp(argv)) return HELP.page;
  const { values, positionals } = parse(argv, {
    command: "gsc page",
    flags: { ...DATE_FLAGS, series: { type: "boolean" } },
  });
  const page = required(positionals[0], "<url>", "gsc page", `${BIN} gsc page https://example.com/post`);
  const dates = gscWindow(values);
  const payload = await insights(resolveProject(values.project), "/gsc/pages/details", {
    query: { ...dates, page },
  });
  return { page, ...detail(payload, "queries", page, values, dates) };
}

async function queryDetails(argv) {
  if (wantsHelp(argv)) return HELP.query;
  const { values, positionals } = parse(argv, {
    command: "gsc query",
    flags: { ...DATE_FLAGS, series: { type: "boolean" } },
  });
  const text = required(positionals[0], "<text>", "gsc query", `${BIN} gsc query "self hosted analytics"`);
  const dates = gscWindow(values);
  const payload = await insights(resolveProject(values.project), "/gsc/queries/details", {
    query: { ...dates, query: text },
  });
  return { query: text, ...detail(payload, "pages", text, values, dates) };
}

export const gscCommand = makeDispatcher(
  "gsc",
  {
    overview,
    pages: listing("pages", "/gsc/pages"),
    queries: listing("queries", "/gsc/queries"),
    page: pageDetails,
    query: queryDetails,
    opportunities: listing(
      "opportunities",
      "/gsc/queries/opportunities",
      { "min-impressions": { type: "string" } },
      (values) => ({ minImpressions: positiveInt(values["min-impressions"], "--min-impressions", 50) }),
    ),
    cannibalization: listing("cannibalization", "/gsc/cannibalization"),
  },
  {
    fallback: "overview",
    summary: {
      overview: "Clicks, impressions, CTR, position over time (default)",
      pages: "Top pages by clicks",
      queries: "Top search queries by clicks",
      page: "One page's performance and the queries driving it",
      query: "One query's performance and the pages ranking for it",
      opportunities: "Queries ranking 4-20 with real volume",
      cannibalization: "Queries where your own pages compete",
    },
  },
);
