import { AxiError } from "axi-sdk-js";
import { DATE_FLAGS, dateFlagHelp, dateWindow, insights, metricValue, resolveProject } from "../api.js";
import { BIN, helpFor, makeDispatcher, parse, positiveInt, required, wantsHelp } from "../args.js";

const FLOW_MODES = ["after", "before", "between"];

const HELP = {
  funnel: helpFor({
    command: "funnel",
    description: "Conversion between 2-10 events, in order, with the biggest drop-off flagged",
    usage: `${BIN} funnel <event> <event> [<event>...] [--range <window>] [--window-hours <n>] [--by session|profile]`,
    flags: {
      ...dateFlagHelp(),
      "--window-hours": "Hours a visitor has to complete the funnel (default 24, max 720)",
      "--by": "Count session (default) or profile conversions",
    },
    examples: [
      `${BIN} funnel screen_view signup`,
      `${BIN} funnel view_pricing checkout purchase --range 30d --window-hours 72`,
    ],
  }),
  flow: helpFor({
    command: "flow",
    description: "Where visitors go before, after, or between events",
    usage: `${BIN} flow <event> [--end <event>] [--mode after|before|between] [--steps <n>] [--range <window>]`,
    flags: {
      ...dateFlagHelp(),
      "--end": "Destination event, required for --mode between",
      "--mode": `One of ${FLOW_MODES.join(", ")} (default after)`,
      "--steps": "Hops to follow, 2-10 (default 5)",
    },
    examples: [`${BIN} flow screen_view`, `${BIN} flow signup --mode before --steps 3`],
  }),
  retention: helpFor({
    command: "retention",
    description: "Week-over-week retention as a series, or `retention cohort` for the table",
    usage: `${BIN} retention [cohort]`,
    examples: [`${BIN} retention`, `${BIN} retention cohort`],
  }),
  engagement: helpFor({
    command: "engagement",
    description: "How engaged visitors are, and how that is distributed",
    usage: `${BIN} engagement`,
    examples: [`${BIN} engagement`],
  }),
  active: helpFor({
    command: "active-users",
    description: "Rolling active users — DAU at 1 day, WAU at 7, MAU at 30",
    usage: `${BIN} active-users [--days <n>]`,
    flags: { "--days": "Rolling window in days, 1-90 (default 7 = WAU)" },
    examples: [`${BIN} active-users`, `${BIN} active-users --days 30`],
  }),
};

/** The last step has no drop-off to report; `null%` is not a number. */
function percent(value) {
  return typeof value === "number" ? `${metricValue("rate", value)}%` : "-";
}

export async function funnelCommand(argv) {
  if (wantsHelp(argv)) return HELP.funnel;
  const { values, positionals } = parse(argv, {
    command: "funnel",
    flags: { ...DATE_FLAGS, "window-hours": { type: "string" }, by: { type: "string" } },
  });
  if (positionals.length < 2) {
    throw new AxiError("a funnel needs at least 2 events", "VALIDATION_ERROR", [
      `Example: ${BIN} funnel screen_view signup`,
      `Run \`${BIN} events names\` to see which event names exist`,
    ]);
  }
  if (positionals.length > 10) {
    throw new AxiError("a funnel takes at most 10 events", "VALIDATION_ERROR", [
      "Drop the least interesting steps and re-run",
    ]);
  }
  const by = values.by ?? "session";
  if (!["session", "profile"].includes(by)) {
    throw new AxiError(`unknown --by ${by}`, "VALIDATION_ERROR", ["valid values: session, profile"]);
  }

  const project = resolveProject(values.project);
  const query = dateWindow(values);
  const payload = await insights(project, "/funnel", {
    query: {
      ...query,
      steps: positionals,
      windowHours: positiveInt(values["window-hours"], "--window-hours", 24),
      groupBy: by === "profile" ? "profile_id" : "session_id",
    },
  });

  const steps = payload?.steps ?? [];
  if (!payload?.totalUsers) {
    return {
      window: query.range,
      funnel: `0 ${by}s entered at ${positionals[0]}`,
      help: [`Run \`${BIN} events names\` to check the event names are spelled right`],
    };
  }
  const worst = steps.find((step) => step.isHighestDropoff);
  return {
    window: query.range,
    entered: payload.totalUsers,
    completed: payload.completedUsers,
    conversion: percent(payload.overallConversionRate),
    steps: steps.map((step) => ({
      step: step.step,
      event: step.eventName,
      [by === "profile" ? "profiles" : "sessions"]: step.users,
      from_start: percent(step.conversionRateFromStart),
      dropoff: percent(step.dropoffPercent),
    })),
    ...(worst ? { biggest_dropoff: `${worst.eventName} (-${percent(worst.dropoffPercent)})` } : {}),
  };
}

export async function flowCommand(argv) {
  if (wantsHelp(argv)) return HELP.flow;
  const { values, positionals } = parse(argv, {
    command: "flow",
    flags: { ...DATE_FLAGS, end: { type: "string" }, mode: { type: "string" }, steps: { type: "string" } },
  });
  const startEvent = required(positionals[0], "<event>", "flow", `${BIN} flow screen_view`);
  const mode = values.mode ?? "after";
  if (!FLOW_MODES.includes(mode)) {
    throw new AxiError(`unknown --mode ${mode}`, "VALIDATION_ERROR", [
      `valid modes: ${FLOW_MODES.join(", ")}`,
    ]);
  }
  if (mode === "between" && !values.end) {
    throw new AxiError("--mode between needs --end <event>", "VALIDATION_ERROR", [
      `Example: ${BIN} flow signup --end purchase --mode between`,
    ]);
  }

  const project = resolveProject(values.project);
  const query = dateWindow(values);
  const payload = await insights(project, "/user_flow", {
    query: {
      ...query,
      startEvent,
      endEvent: values.end,
      mode,
      steps: positiveInt(values.steps, "--steps", 5),
    },
  });

  const links = payload?.links ?? [];
  const nodes = payload?.nodes ?? [];
  if (links.length === 0) {
    return { window: query.range, flow: `no paths ${mode} ${startEvent} in this window` };
  }
  const name = new Map(nodes.map((node) => [node.id, node.label]));
  return {
    window: query.range,
    mode,
    from: startEvent,
    // The Sankey's nodes carry the layout; an agent only needs the edges.
    paths: links
      .map((link) => ({
        from: name.get(link.source) ?? link.source,
        to: name.get(link.target) ?? link.target,
        sessions: link.value,
      }))
      .sort((a, b) => b.sessions - a.sessions),
  };
}

async function retentionSeries(argv) {
  if (wantsHelp(argv)) return HELP.retention;
  const { values } = parse(argv, { command: "retention" });
  const rows = await insights(resolveProject(values.project), "/retention", {});
  const series = Array.isArray(rows) ? rows : [];
  if (series.length === 0) {
    return {
      retention: "0 weeks of retention data yet",
      help: ["Retention needs several weeks of returning visitors before it reports anything"],
    };
  }
  return { count: `${series.length} weeks`, retention: series };
}

async function retentionCohort(argv) {
  if (wantsHelp(argv)) return HELP.retention;
  const { values } = parse(argv, { command: "retention cohort" });
  const rows = await insights(resolveProject(values.project), "/retention/cohort", {});
  const cohorts = Array.isArray(rows) ? rows : [];
  if (cohorts.length === 0) {
    return {
      cohorts: "0 cohorts yet",
      help: ["A cohort needs a week of first-seen visitors plus a week of return visits"],
    };
  }
  return { count: `${cohorts.length} cohorts`, cohorts };
}

export const retentionCommand = makeDispatcher(
  "retention",
  { series: retentionSeries, cohort: retentionCohort },
  {
    fallback: "series",
    summary: { series: "Week-over-week retention series (default)", cohort: "Retention cohort table" },
  },
);

export async function engagementCommand(argv) {
  if (wantsHelp(argv)) return HELP.engagement;
  const { values } = parse(argv, { command: "engagement" });
  const payload = await insights(resolveProject(values.project), "/engagement", {});
  const summary = payload?.summary ?? {};
  if (Object.keys(summary).length === 0) {
    return { engagement: "no engagement data for this project yet" };
  }
  return {
    engagement: Object.fromEntries(
      Object.entries(summary).map(([key, value]) => [key, metricValue(key, value)]),
    ),
    ...(payload?.distribution?.length ? { distribution: payload.distribution } : {}),
  };
}

export async function activeUsersCommand(argv) {
  if (wantsHelp(argv)) return HELP.active;
  const { values } = parse(argv, { command: "active-users", flags: { days: { type: "string" } } });
  const days = positiveInt(values.days, "--days", 7);
  if (days > 90) {
    throw new AxiError("--days is capped at 90", "VALIDATION_ERROR", ["Pass a value between 1 and 90"]);
  }
  const payload = await insights(resolveProject(values.project), "/active_users", { query: { days } });
  const series = payload?.series ?? [];
  if (series.length === 0) {
    return { active_users: `no rolling ${days}-day data yet` };
  }
  const last = series[series.length - 1];
  return {
    window: payload.label ?? `${days}d rolling`,
    // Named for what it is: the final bucket the API filled, which can sit
    // slightly ahead of today depending on the window it rolls over.
    last_point: `${last.users} users on ${String(last.date).slice(0, 10)}`,
    count: `${series.length} points`,
    series: series.map((point) => ({ date: String(point.date).slice(0, 10), users: point.users })),
  };
}
