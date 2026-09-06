import { AxiError } from "axi-sdk-js";
import { BIN } from "./args.js";

const CLOUD = "https://api.openpanel.dev";

/** `zRange` in @openpanel/validation, minus `custom` (use --start/--end instead). */
export const RANGES = [
  "30min",
  "lastHour",
  "last24h",
  "today",
  "yesterday",
  "7d",
  "30d",
  "3m",
  "6m",
  "12m",
  "monthToDate",
  "lastMonth",
  "yearToDate",
  "lastYear",
];

/** `overviewColumns` in the API's insights controller — one route per column. */
export const DIMENSIONS = [
  "referrer",
  "referrer_name",
  "referrer_type",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "region",
  "country",
  "city",
  "device",
  "brand",
  "model",
  "browser",
  "browser_version",
  "os",
  "os_version",
];

export function baseUrl(env = process.env) {
  return (env.OPENPANEL_API_URL || CLOUD).replace(/\/+$/, "");
}

export function hasCredentials(env = process.env) {
  return Boolean(env.OPENPANEL_CLIENT_ID && env.OPENPANEL_CLIENT_SECRET);
}

export const WRITE_HELP = [
  "Tracking needs a `write` or `root` client — a `read` client is refused",
  "Export it as OPENPANEL_WRITE_CLIENT_ID and OPENPANEL_WRITE_CLIENT_SECRET",
  "A `root` client in OPENPANEL_CLIENT_ID covers both directions",
];

export const CREDENTIAL_HELP = [
  "Create a `read` client under Settings -> API Clients in your OpenPanel dashboard",
  "Export it as OPENPANEL_CLIENT_ID and OPENPANEL_CLIENT_SECRET",
  "Self-hosted: also export OPENPANEL_API_URL (e.g. https://openpanel.example.com/api)",
];

/**
 * Reads and writes use different client types, so they get separate variables.
 * A write command prefers the write pair and falls back to the main one, which
 * is correct when that client is `root` and refused loudly when it is `read`.
 */
export function credentials(env = process.env, { write = false } = {}) {
  if (write && env.OPENPANEL_WRITE_CLIENT_ID && env.OPENPANEL_WRITE_CLIENT_SECRET) {
    return {
      clientId: env.OPENPANEL_WRITE_CLIENT_ID,
      clientSecret: env.OPENPANEL_WRITE_CLIENT_SECRET,
    };
  }
  if (!hasCredentials(env)) {
    throw new AxiError(
      "No OpenPanel client credentials in the environment",
      "AUTH_REQUIRED",
      write ? WRITE_HELP : CREDENTIAL_HELP,
    );
  }
  return { clientId: env.OPENPANEL_CLIENT_ID, clientSecret: env.OPENPANEL_CLIENT_SECRET };
}

export const PROJECT_HELP = [
  `Pass \`--project <id>\` or export OPENPANEL_PROJECT_ID`,
  "The id is the uuid in your dashboard URL, e.g. /<org>/<projectId>/overview",
  `Run \`${BIN} projects\` with a root client to list ids`,
];

/**
 * The project id is mandatory, never defaulted. Older OpenPanel releases read
 * `:projectId` straight off the URL with no client scoping, so a placeholder
 * would return an empty 200 — a silent wrong answer rather than an error.
 */
export function resolveProject(selector, env = process.env) {
  const id = selector || env.OPENPANEL_PROJECT_ID;
  if (!id) {
    throw new AxiError("No OpenPanel project id given", "VALIDATION_ERROR", PROJECT_HELP);
  }
  return id;
}

export function resolveRange(value, fallback = "7d") {
  if (value === undefined) return fallback;
  if (!RANGES.includes(value)) {
    throw new AxiError(`unknown --range ${value}`, "VALIDATION_ERROR", [
      `valid ranges: ${RANGES.join(", ")}`,
      "Or pass an explicit window with --start <date> --end <date>",
    ]);
  }
  return value;
}

function apiError(status, payload, path) {
  const message = payload?.message || payload?.error || `OpenPanel request failed (HTTP ${status})`;

  if (status === 401) {
    // Which client type is missing depends on the surface, and saying "check
    // your credentials" sends the user off verifying a secret that is fine.
    if (path.startsWith("/track")) {
      return new AxiError(message, "AUTH_ERROR", WRITE_HELP);
    }
    if (path.startsWith("/manage")) {
      return new AxiError(message, "AUTH_ERROR", [
        "The Manage API needs a `root` client — `read` and `write` are both refused",
        "Create one under Settings -> API Clients, then export it as OPENPANEL_CLIENT_ID",
      ]);
    }
    return new AxiError(message, "AUTH_ERROR", [
      "Insights and Export need a `read` or `root` client — the default project client is write-only",
      ...CREDENTIAL_HELP.slice(0, 2),
    ]);
  }
  if (status === 403) {
    return new AxiError(message, "AUTH_ERROR", [
      "This client is scoped to a different project",
      `Run \`${BIN} projects\` with a root client, or use the read client that owns this project`,
    ]);
  }
  if (status === 404) {
    return new AxiError(message, "NOT_FOUND", [
      `${path} is not served by this OpenPanel instance`,
      "Check OPENPANEL_API_URL points at the API (self-hosted instances serve it under /api)",
    ]);
  }
  if (status === 429) {
    return new AxiError(message, "RATE_LIMITED", [
      "Insights and Export allow 100 requests per 10 seconds per client; wait and retry",
    ]);
  }
  return new AxiError(message, "API_ERROR", [`while requesting ${path}`]);
}

/**
 * One request against the OpenPanel API. Structured JSON only — the caller
 * projects it down to an agent-sized schema before it reaches stdout.
 */
export async function op(path, options = {}) {
  const {
    query,
    method = "GET",
    body,
    write = false,
    allowEmpty = false,
    env = process.env,
    fetchImpl = fetch,
  } = options;
  const { clientId, clientSecret } = credentials(env, { write });
  const url = new URL(baseUrl(env) + path);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  let response;
  try {
    response = await fetchImpl(url.toString(), {
      method,
      headers: {
        "openpanel-client-id": clientId,
        "openpanel-client-secret": clientSecret,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    throw new AxiError(`Could not reach the OpenPanel API: ${cause.message}`, "NETWORK_ERROR", [
      `Check network connectivity to ${baseUrl(env)}`,
      "Self-hosted: confirm OPENPANEL_API_URL is reachable from here",
    ]);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    // `/track` answers with a bare 200 and no body; every other route is JSON,
    // so an unparseable body there means the URL points somewhere else.
    if (response.ok && allowEmpty) return {};
    throw new AxiError(
      `OpenPanel returned a non-JSON response (HTTP ${response.status})`,
      "API_ERROR",
      [`while requesting ${path}`, "Check OPENPANEL_API_URL points at the API, not the dashboard"],
    );
  }
  if (!response.ok) throw apiError(response.status, payload, path);
  return payload;
}

/** Insights routes are all `/insights/:projectId/<path>`. */
export function insights(project, path, options = {}) {
  return op(`/insights/${encodeURIComponent(project)}${path}`, options);
}

/**
 * The date window every insights read shares. `--start`/`--end` win over
 * `--range` upstream, so passing both is not an error — it is the escape hatch
 * for a window the named ranges do not cover.
 */
export function dateWindow(values) {
  return {
    range: resolveRange(values.range),
    startDate: values.start,
    endDate: values.end,
  };
}

export const DATE_FLAGS = {
  range: { type: "string" },
  start: { type: "string" },
  end: { type: "string" },
};

export function dateFlagHelp(fallback = "7d") {
  return {
    "--range": `Named window (default ${fallback}): ${RANGES.join(", ")}`,
    "--start": "Window start as YYYY-MM-DD (overrides --range)",
    "--end": "Window end as YYYY-MM-DD",
  };
}

/**
 * Empty dimension values come back as null; name them rather than printing a
 * blank. For a referrer column an empty value is not "unknown" — it means the
 * visit had no referrer, i.e. direct traffic, and an agent reading "(none)"
 * would report an unidentified source instead.
 */
export function label(value, empty = "(none)") {
  return value === null || value === undefined || value === "" ? empty : value;
}

export const isReferrer = (dimension) => dimension.startsWith("referrer");

/**
 * `avg_session_duration` is seconds, and ClickHouse hands it over with full
 * float noise (`962.0422199999999`). Sub-second precision on a session average
 * is not information, it is tokens — round it, and clamp the rest to 2 places.
 * Both the `metrics` command and the dashboard render this payload, so the
 * rounding lives here rather than in either of them.
 */
export function metricValue(field, value) {
  if (typeof value !== "number") return value;
  if (field === "avg_session_duration") return Math.round(value);
  return Number(value.toFixed(2));
}
