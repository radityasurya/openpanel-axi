import { AxiError } from "axi-sdk-js";
import { op, resolveProject } from "../api.js";
import { BIN, helpFor, parse, positiveInt, wantsHelp } from "../args.js";

const DEFAULT_LIMIT = 20;
// The API clamps `limit` to 1000 silently, which would return a page that looks
// like the whole answer. Refuse the request instead and name the paging flag.
const MAX_LIMIT = 1000;

const HELP = helpFor({
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

/** Events carry ~25 fields each; these are the ones that identify a hit. */
function row(event, properties) {
  return {
    time: String(event.createdAt ?? "").replace(".000Z", "Z"),
    name: event.name,
    path: event.path || "-",
    country: event.country || "-",
    device: event.device || "-",
    referrer: event.referrerName || event.referrer || "-",
    ...(properties ? { properties: event.properties ?? {} } : {}),
  };
}

export async function eventsCommand(argv) {
  if (wantsHelp(argv)) return HELP;
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
      // The API accepts `event` repeated; URLSearchParams.set would drop all
      // but the last, so a multi-name filter goes over as a comma list.
      event: values.event?.join(","),
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
