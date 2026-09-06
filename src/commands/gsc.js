import { DATE_FLAGS, dateFlagHelp, dateWindow, insights, metricValue, resolveProject } from "../api.js";
import { BIN, helpFor, makeDispatcher, parse, positiveInt, required, wantsHelp } from "../args.js";

const DEFAULT_LIMIT = 20;

const NOT_CONNECTED = [
  "Connect Google Search Console in the dashboard under the project's settings",
  "It is a Google OAuth flow and cannot be done from this CLI",
];

const HELP = {
  overview: helpFor({
    command: "gsc overview",
    description: "Search performance over time: clicks, impressions, CTR, average position",
    usage: `${BIN} gsc overview [--range <window>] [--interval day|week|month]`,
    flags: { ...dateFlagHelp(), "--interval": "Bucket size (default day)" },
    examples: [`${BIN} gsc overview --range 30d`],
  }),
  pages: helpFor({
    command: "gsc pages",
    description: "Top pages in Google search, ranked by clicks",
    usage: `${BIN} gsc pages [--limit <n>] [--range <window>]`,
    flags: { ...dateFlagHelp(), "--limit": `Rows to show (default ${DEFAULT_LIMIT})` },
    examples: [`${BIN} gsc pages --range 30d`],
  }),
  queries: helpFor({
    command: "gsc queries",
    description: "Top search queries, ranked by clicks",
    usage: `${BIN} gsc queries [--limit <n>] [--range <window>]`,
    flags: { ...dateFlagHelp(), "--limit": `Rows to show (default ${DEFAULT_LIMIT})` },
    examples: [`${BIN} gsc queries`],
  }),
  page: helpFor({
    command: "gsc page",
    description: "One page's search performance, with the queries driving it",
    usage: `${BIN} gsc page <url> [--range <window>]`,
    examples: [`${BIN} gsc page https://example.com/blog/post`],
  }),
  query: helpFor({
    command: "gsc query",
    description: "One search query, with the pages that rank for it",
    usage: `${BIN} gsc query "<text>" [--range <window>]`,
    examples: [`${BIN} gsc query "openpanel self hosted"`],
  }),
  opportunities: helpFor({
    command: "gsc opportunities",
    description: "Queries ranking 4-20 with real volume — the cheapest SEO wins",
    usage: `${BIN} gsc opportunities [--min-impressions <n>] [--range <window>]`,
    flags: { ...dateFlagHelp(), "--min-impressions": "Volume floor (default 50)" },
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
    if (["clicks", "impressions", "ctr", "position", "page", "query", "url", "keys"].includes(key)) {
      projected[key] = typeof value === "number" ? metricValue(key, value) : value;
    }
  }
  return Object.keys(projected).length ? projected : row;
}

function empty(what, range) {
  return {
    window: range,
    [what]: `0 ${what} reported by Search Console in this window`,
    help: [
      "Search Console data lags by 2-3 days; try a wider --range",
      ...NOT_CONNECTED,
    ],
  };
}

function listing(name, path, extraFlags = {}, buildQuery = () => ({})) {
  return async function run(argv) {
    if (wantsHelp(argv)) return HELP[name];
    const { values } = parse(argv, {
      command: `gsc ${name}`,
      flags: { ...DATE_FLAGS, limit: { type: "string" }, ...extraFlags },
    });
    const query = dateWindow(values);
    const payload = await insights(resolveProject(values.project), path, {
      query: { ...query, limit: positiveInt(values.limit, "--limit", DEFAULT_LIMIT), ...buildQuery(values) },
    });
    const rows = Array.isArray(payload) ? payload : (payload?.rows ?? payload?.data ?? []);
    if (!Array.isArray(rows) || rows.length === 0) return empty(name, query.range);
    return {
      window: query.range,
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
  const query = dateWindow(values);
  const payload = await insights(resolveProject(values.project), "/gsc/overview", {
    query: { ...query, interval: values.interval ?? "day" },
  });
  const series = payload?.series ?? (Array.isArray(payload) ? payload : []);
  if (series.length === 0) return empty("overview", query.range);
  return {
    window: query.range,
    ...(payload?.summary ? { summary: searchRow(payload.summary) } : {}),
    count: `${series.length} points`,
    series: series.map((point) => ({
      date: String(point.date ?? "").slice(0, 10),
      ...searchRow(point),
    })),
  };
}

async function pageDetails(argv) {
  if (wantsHelp(argv)) return HELP.page;
  const { values, positionals } = parse(argv, { command: "gsc page", flags: DATE_FLAGS });
  const page = required(positionals[0], "<url>", "gsc page", `${BIN} gsc page https://example.com/post`);
  const query = dateWindow(values);
  const payload = await insights(resolveProject(values.project), "/gsc/pages/details", {
    query: { ...query, page },
  });
  return { window: query.range, page, details: payload };
}

async function queryDetails(argv) {
  if (wantsHelp(argv)) return HELP.query;
  const { values, positionals } = parse(argv, { command: "gsc query", flags: DATE_FLAGS });
  const text = required(positionals[0], "<text>", "gsc query", `${BIN} gsc query "self hosted analytics"`);
  const query = dateWindow(values);
  const payload = await insights(resolveProject(values.project), "/gsc/queries/details", {
    query: { ...query, query: text },
  });
  return { window: query.range, query: text, details: payload };
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
