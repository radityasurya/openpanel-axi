import { AxiError } from "axi-sdk-js";
import { insights, op, resolveProject } from "../api.js";
import { BIN, helpFor, makeDispatcher, parse, positiveInt, required, wantsHelp } from "../args.js";

const DEFAULT_LIMIT = 20;
// The API clamps `limit` to 1000 silently, which would return a page that looks
// like the whole answer. Refuse the request instead and name the paging flag.
const MAX_LIMIT = 1000;

const LIST_HELP = helpFor({
  command: "events",
  description: "Raw events, newest first, with the total matching count",
  usage: `${BIN} events [--event <name>] [--limit <n>] [--page <n>] [--start <date>] [--end <date>] [--profile <id>] [--properties]`,
  flags: {
    "--event": "Only this event name (repeatable)",
    "--limit": `Events per page (default ${DEFAULT_LIMIT}, max 1000)`,
    "--page": "1-based page number (default 1)",
    "--start": "Only events at or after this date",
    "--end": "Only events at or before this date",
    "--profile": "Only events for this profile id",
    "--properties": "Include each event's custom properties",
  },
  examples: [
    `${BIN} events`,
    `${BIN} events --event screen_view --limit 50`,
    `${BIN} events --event signup --properties`,
  ],
});

// `device` and `referrer` are omitted from the payload unless named in
// `includes` — without this the default schema prints "-" for data that exists.
const INCLUDES = "device,referrer";

/** Events carry ~25 fields each; these are the ones that identify a hit. */
function row(event, properties) {
  return {
    time: String(event.createdAt ?? "").replace(".000Z", "Z"),
    name: event.name,
    path: event.path || "-",
    country: event.country || "-",
    device: event.device || "-",
    referrer: event.referrerName || event.referrer || "(direct)",
    ...(properties ? { properties: event.properties ?? {} } : {}),
  };
}

async function list(argv) {
  if (wantsHelp(argv)) return LIST_HELP;
  const { values } = parse(argv, {
    command: "events",
    flags: {
      event: { type: "string", multiple: true },
      limit: { type: "string" },
      page: { type: "string" },
      start: { type: "string" },
      end: { type: "string" },
      profile: { type: "string" },
      properties: { type: "boolean" },
    },
  });
  const projectId = resolveProject(values.project);
  const limit = positiveInt(values.limit, "--limit", DEFAULT_LIMIT);
  if (limit > MAX_LIMIT) {
    throw new AxiError(`--limit ${limit} is above the API maximum`, "VALIDATION_ERROR", [
      `The API caps a page at ${MAX_LIMIT} events and silently clamps a larger request`,
      `Run \`${BIN} events --limit ${MAX_LIMIT} --page 2\` for the next page instead`,
    ]);
  }
  const page = positiveInt(values.page, "--page", 1);

  const payload = await op("/export/events", {
    query: {
      projectId,
      limit,
      page,
      start: values.start,
      end: values.end,
      profileId: values.profile,
      includes: INCLUDES,
      // Passed as an array so `op` repeats the parameter. A comma-joined value
      // matches an event named "a,b" and returns 0 rows.
      event: values.event,
    },
  });
  const data = payload?.data ?? [];
  const total = payload?.meta?.totalCount ?? data.length;
  const filter = values.event?.length ? ` named ${values.event.join(", ")}` : "";

  if (data.length === 0) {
    return {
      events: `0 events${filter} matched`,
      help: [
        `Run \`${BIN} events\` without --event to see which names are in use`,
        `Run \`${BIN} live\` to check the project is receiving traffic`,
      ],
    };
  }

  return {
    count: `${data.length} of ${total} total`,
    page: `${payload?.meta?.current ?? page} of ${payload?.meta?.pages ?? 1}`,
    events: data.map((event) => row(event, values.properties)),
    help: [
      ...(data.length < total ? [`Run \`${BIN} events --page ${page + 1}\` for the next page`] : []),
      ...(values.properties ? [] : [`Run \`${BIN} events --properties\` to include custom properties`]),
      `Run \`${BIN} metrics\` for the aggregate instead of raw events`,
    ],
  };
}


const HELP = {
  names: helpFor({
    command: "events names",
    description: "Every distinct event name in the project — start here when you do not know them",
    usage: `${BIN} events names`,
    examples: [`${BIN} events names`],
  }),
  properties: helpFor({
    command: "events properties",
    description: "Property keys recorded for an event, or across all events",
    usage: `${BIN} events properties [<event>]`,
    examples: [`${BIN} events properties`, `${BIN} events properties screen_view`],
  }),
  values: helpFor({
    command: "events values",
    description: "The distinct values a property takes",
    usage: `${BIN} events values <event> <property>`,
    examples: [`${BIN} events values screen_view path`],
  }),
};

async function names(argv) {
  if (wantsHelp(argv)) return HELP.names;
  const { values } = parse(argv, { command: "events names" });
  const rows = await insights(resolveProject(values.project), "/events/names", {});
  const found = Array.isArray(rows) ? rows : [];
  if (found.length === 0) {
    return { events: "0 event names recorded in this project" };
  }
  return {
    count: `${found.length} total`,
    // The endpoint returns bare strings, not records.
    events: found.map((name) => (typeof name === "string" ? name : (name?.name ?? String(name)))),
    help: [
      `Run \`${BIN} events --event <name>\` for the raw events`,
      `Run \`${BIN} events properties <name>\` for what each one records`,
    ],
  };
}

async function properties(argv) {
  if (wantsHelp(argv)) return HELP.properties;
  const { values, positionals } = parse(argv, { command: "events properties" });
  const payload = await insights(resolveProject(values.project), "/events/properties", {
    // The querystring key is `eventName`, not `event` as on /export/events.
    query: { eventName: positionals[0] },
  });
  const columns = payload?.columns ?? (Array.isArray(payload) ? payload : []);
  const properties_ = payload?.properties ?? [];
  if (columns.length === 0 && properties_.length === 0) {
    return { properties: `0 properties recorded${positionals[0] ? ` for ${positionals[0]}` : ""}` };
  }
  return {
    ...(positionals[0] ? { event: positionals[0] } : {}),
    ...(columns.length ? { columns } : {}),
    ...(properties_.length ? { properties: properties_ } : {}),
    help: [`Run \`${BIN} events values <event> <property>\` for the values one of them takes`],
  };
}

async function propertyValues(argv) {
  if (wantsHelp(argv)) return HELP.values;
  const { values, positionals } = parse(argv, { command: "events values" });
  const event = required(positionals[0], "<event>", "events values", `${BIN} events values screen_view path`);
  const property = required(positionals[1], "<property>", "events values", `${BIN} events values ${event} path`);
  const payload = await insights(resolveProject(values.project), "/events/property_values", {
    query: { eventName: event, propertyKey: property },
  });
  const found = payload?.values ?? (Array.isArray(payload) ? payload : []);
  if (found.length === 0) {
    return { event, property, values: `0 values recorded for ${property}` };
  }
  return { event, property, count: `${found.length} total`, values: found };
}

export const eventsCommand = makeDispatcher(
  "events",
  { list, names, properties, values: propertyValues },
  {
    fallback: "list",
    summary: {
      list: "Raw events, newest first (default)",
      names: "Every distinct event name",
      properties: "Property keys for an event",
      values: "Distinct values a property takes",
    },
  },
);
