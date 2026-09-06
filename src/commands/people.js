import {
  DATE_FLAGS,
  FIELDS_FLAG,
  dateFlagHelp,
  dateWindow,
  extraFields,
  fieldsHelp,
  insights,
  metricValue,
  resolveProject,
} from "../api.js";
import { BIN, helpFor, makeDispatcher, parse, positiveInt, required, wantsHelp } from "../args.js";

const DEFAULT_LIMIT = 20;

// Profiles and sessions carry 11 and 38 fields; these identify one without
// dragging every UTM column and coordinate into the output.
const FILTERS = {
  country: { type: "string" },
  city: { type: "string" },
  device: { type: "string" },
  browser: { type: "string" },
};

const HELP = {
  list: helpFor({
    command: "profiles list",
    description: "Find user profiles by trait, location, activity, or an event they performed",
    usage: `${BIN} profiles [--email <e>] [--country <c>] [--device <d>] [--min-sessions <n>] [--inactive-days <n>] [--performed <event>] [--limit <n>]`,
    flags: {
      "--name": "Match on name",
      "--email": "Match on email",
      ...Object.fromEntries(Object.keys(FILTERS).map((key) => [`--${key}`, `Match on ${key}`])),
      "--min-sessions": "Only profiles with at least this many sessions",
      "--inactive-days": "Only profiles not seen for this many days",
      "--performed": "Only profiles that fired this event",
      "--limit": `Rows to show, max 100 (default ${DEFAULT_LIMIT})`,
      ...fieldsHelp,
    },
    examples: [`${BIN} profiles --country NL`, `${BIN} profiles --performed signup --min-sessions 3`],
  }),
  get: helpFor({
    command: "profiles get",
    description: "One profile with its most recent events",
    usage: `${BIN} profiles get <profileId> [--events <n>]`,
    flags: { "--events": "Recent events to include, max 100 (default 20)" },
    examples: [`${BIN} profiles get user_123`],
  }),
  sessions: helpFor({
    command: "profiles sessions",
    description: "Sessions for one profile, newest first",
    usage: `${BIN} profiles sessions <profileId> [--limit <n>]`,
    examples: [`${BIN} profiles sessions user_123`],
  }),
  metrics: helpFor({
    command: "profiles metrics",
    description: "Lifetime metrics for one profile",
    usage: `${BIN} profiles metrics <profileId>`,
    examples: [`${BIN} profiles metrics user_123`],
  }),
  sessionList: helpFor({
    command: "sessions",
    description: "Sessions with duration, entry/exit pages, and bounce status",
    usage: `${BIN} sessions [--country <c>] [--device <d>] [--profile <id>] [--limit <n>] [--range <window>]`,
    flags: {
      ...dateFlagHelp(),
      ...Object.fromEntries(Object.keys(FILTERS).map((key) => [`--${key}`, `Only sessions from this ${key}`])),
      "--os": "Only sessions on this OS",
      "--profile": "Only sessions for this profile id",
      "--limit": `Rows to show, max 100 (default ${DEFAULT_LIMIT})`,
      ...fieldsHelp,
    },
    examples: [`${BIN} sessions --limit 5`, `${BIN} sessions --country NL --device mobile`],
  }),
};

function profileRow(profile, fields) {
  const name = [profile.first_name, profile.last_name].filter(Boolean).join(" ");
  return {
    id: profile.id,
    ...(name ? { name } : {}),
    ...(profile.email ? { email: profile.email } : {}),
    last_seen: String(profile.last_seen_at ?? "").slice(0, 19).replace("T", " "),
    ...extraFields(fields, profile, "profiles"),
  };
}

function sessionRow(session, fields) {
  return {
    id: session.id,
    started: String(session.created_at ?? "").slice(0, 19).replace("T", " "),
    duration_s: session.duration ? Math.round(session.duration / 1000) : 0,
    views: session.screen_view_count,
    bounce: Boolean(session.is_bounce),
    entry: session.entry_path || "-",
    exit: session.exit_path || "-",
    country: session.country || "-",
    device: session.device || "-",
    ...extraFields(fields, session, "sessions"),
  };
}

async function list(argv) {
  if (wantsHelp(argv)) return HELP.list;
  const { values } = parse(argv, {
    command: "profiles list",
    flags: {
      ...FILTERS,
      name: { type: "string" },
      email: { type: "string" },
      "min-sessions": { type: "string" },
      "inactive-days": { type: "string" },
      performed: { type: "string" },
      limit: { type: "string" },
      ...FIELDS_FLAG,
    },
  });
  const limit = positiveInt(values.limit, "--limit", DEFAULT_LIMIT);
  const rows = await insights(resolveProject(values.project), "/profiles", {
    query: {
      name: values.name,
      email: values.email,
      country: values.country,
      city: values.city,
      device: values.device,
      browser: values.browser,
      minSessions: values["min-sessions"],
      inactiveDays: values["inactive-days"],
      performedEvent: values.performed,
      limit,
    },
  });
  const profiles = Array.isArray(rows) ? rows : [];

  if (profiles.length === 0) {
    return {
      profiles: "0 profiles matched",
      help: [`Run \`${BIN} profiles\` with no filters to see whether any exist`],
    };
  }
  return {
    count: `${profiles.length} shown`,
    profiles: profiles.map((profile) => profileRow(profile, values.fields)),
    help: [`Run \`${BIN} profiles get <id>\` for one profile and its recent events`],
  };
}

async function get(argv) {
  if (wantsHelp(argv)) return HELP.get;
  const { values, positionals } = parse(argv, {
    command: "profiles get",
    flags: { events: { type: "string" } },
  });
  const id = required(positionals[0], "<profileId>", "profiles get", `${BIN} profiles get user_123`);
  const payload = await insights(
    resolveProject(values.project),
    `/profiles/${encodeURIComponent(id)}`,
    { query: { eventLimit: positiveInt(values.events, "--events", 20) } },
  );
  const events = payload?.recentEvents ?? [];
  return {
    profile: profileRow(payload?.profile ?? { id }),
    ...(payload?.profile?.properties && Object.keys(payload.profile.properties).length
      ? { properties: payload.profile.properties }
      : {}),
    recent_events: events.map((event) => ({
      time: String(event.createdAt ?? event.created_at ?? "").slice(0, 19).replace("T", " "),
      name: event.name,
      path: event.path || "-",
    })),
    help: [`Run \`${BIN} profiles metrics ${id}\` for lifetime totals`],
  };
}

async function sessionsFor(argv) {
  if (wantsHelp(argv)) return HELP.sessions;
  const { values, positionals } = parse(argv, {
    command: "profiles sessions",
    flags: { limit: { type: "string" } },
  });
  const id = required(positionals[0], "<profileId>", "profiles sessions", `${BIN} profiles sessions user_123`);
  const rows = await insights(
    resolveProject(values.project),
    `/profiles/${encodeURIComponent(id)}/sessions`,
    { query: { limit: positiveInt(values.limit, "--limit", DEFAULT_LIMIT) } },
  );
  const sessions = Array.isArray(rows) ? rows : [];
  return sessions.length === 0
    ? { profile: id, sessions: `0 sessions recorded for ${id}` }
    : { profile: id, count: `${sessions.length} shown`, sessions: sessions.map(sessionRow) };
}

async function metrics(argv) {
  if (wantsHelp(argv)) return HELP.metrics;
  const { values, positionals } = parse(argv, { command: "profiles metrics" });
  const id = required(positionals[0], "<profileId>", "profiles metrics", `${BIN} profiles metrics user_123`);
  const payload = await insights(
    resolveProject(values.project),
    `/profiles/${encodeURIComponent(id)}/metrics`,
    {},
  );
  return {
    profile: id,
    metrics: Object.fromEntries(
      Object.entries(payload ?? {}).map(([key, value]) => [key, metricValue(key, value)]),
    ),
  };
}

export const profilesCommand = makeDispatcher(
  "profiles",
  { list, get, sessions: sessionsFor, metrics },
  {
    fallback: "list",
    summary: {
      list: "Find profiles by trait, location, activity, or event",
      get: "One profile with its recent events",
      sessions: "Sessions for one profile",
      metrics: "Lifetime metrics for one profile",
    },
  },
);

export async function sessionsCommand(argv) {
  if (wantsHelp(argv)) return HELP.sessionList;
  const { values } = parse(argv, {
    command: "sessions",
    flags: {
      ...DATE_FLAGS,
      ...FILTERS,
      os: { type: "string" },
      profile: { type: "string" },
      limit: { type: "string" },
      ...FIELDS_FLAG,
    },
  });
  const query = dateWindow(values);
  const rows = await insights(resolveProject(values.project), "/sessions", {
    query: {
      ...query,
      country: values.country,
      city: values.city,
      device: values.device,
      browser: values.browser,
      os: values.os,
      profileId: values.profile,
      limit: positiveInt(values.limit, "--limit", DEFAULT_LIMIT),
    },
  });
  const sessions = Array.isArray(rows) ? rows : [];

  if (sessions.length === 0) {
    return { window: query.range, sessions: "0 sessions matched in this window" };
  }
  const bounced = sessions.filter((session) => session.is_bounce).length;
  return {
    window: query.range,
    count: `${sessions.length} shown`,
    bounced: `${bounced} of ${sessions.length}`,
    sessions: sessions.map((session) => sessionRow(session, values.fields)),
  };
}
