import { AxiError } from "axi-sdk-js";
import { op, resolveProject } from "../api.js";
import { BIN, helpFor, makeDispatcher, parse, positiveInt, required, wantsHelp } from "../args.js";

const HELP = {
  event: helpFor({
    command: "track event",
    description: "Record one event. NOT idempotent — every run adds another event",
    usage: `${BIN} track event <name> [--property k=v] [--profile <id>] [--group <id>]`,
    flags: {
      "--property": "A custom property as key=value (repeatable)",
      "--profile": "Attribute the event to this profile id",
      "--group": "Attach a group id (repeatable); groups are never inferred",
    },
    examples: [
      `${BIN} track event deploy_finished --property service=api --property duration=42`,
      `${BIN} track event signup --profile user_123`,
    ],
  }),
  identify: helpFor({
    command: "track identify",
    description: "Create or update a user profile (upsert — safe to re-run)",
    usage: `${BIN} track identify <profileId> [--email <e>] [--first-name <n>] [--last-name <n>] [--avatar <url>] [--property k=v]`,
    flags: {
      "--email": "Profile email",
      "--first-name": "Given name",
      "--last-name": "Family name",
      "--avatar": "Avatar URL",
      "--property": "A custom property as key=value (repeatable)",
    },
    examples: [`${BIN} track identify user_123 --email a@b.com --first-name Ada`],
  }),
};

/** `k=v`, with the obvious scalar coercions. An agent writing `count=1` means 1. */
function properties(pairs = [], command) {
  const entries = pairs.map((pair) => {
    const index = String(pair).indexOf("=");
    if (index < 1) {
      throw new AxiError(`--property ${pair} is not key=value`, "VALIDATION_ERROR", [
        `Example: ${BIN} ${command} --property plan=pro --property seats=5`,
      ]);
    }
    const key = pair.slice(0, index);
    const raw = pair.slice(index + 1);
    if (raw === "true" || raw === "false") return [key, raw === "true"];
    if (raw !== "" && !Number.isNaN(Number(raw))) return [key, Number(raw)];
    return [key, raw];
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/**
 * Every write goes to `/track` with a `type` discriminator, and the project is
 * taken from the client rather than the payload — so a write client scoped to
 * the wrong project fails at the server, not silently into the wrong dataset.
 */
async function send(type, payload) {
  await op("/track", { method: "POST", body: { type, payload }, write: true, allowEmpty: true });
}

async function event(argv) {
  if (wantsHelp(argv)) return HELP.event;
  const { values, positionals } = parse(argv, {
    command: "track event",
    flags: {
      property: { type: "string", multiple: true },
      profile: { type: "string" },
      group: { type: "string", multiple: true },
    },
  });
  const name = required(positionals[0], "<name>", "track event", `${BIN} track event signup`);
  // Reads take --project; a write is scoped by the client itself, so accepting
  // one here would imply a targeting it does not have.
  if (values.project) {
    throw new AxiError("`track` does not take --project", "VALIDATION_ERROR", [
      "The event lands in the project its write client belongs to",
      "Use a write client from the project you mean",
    ]);
  }

  await send("track", {
    name,
    ...(values.profile ? { profileId: values.profile } : {}),
    ...(values.group?.length ? { groups: values.group } : {}),
    ...(properties(values.property, "track event")
      ? { properties: properties(values.property, "track event") }
      : {}),
  });

  return {
    tracked: name,
    ...(values.profile ? { profile: values.profile } : {}),
    note: "recorded — re-running this command records a second event",
    help: [`Run \`${BIN} events --event ${name} --limit 5\` to confirm it landed`],
  };
}

async function identify(argv) {
  if (wantsHelp(argv)) return HELP.identify;
  const { values, positionals } = parse(argv, {
    command: "track identify",
    flags: {
      email: { type: "string" },
      "first-name": { type: "string" },
      "last-name": { type: "string" },
      avatar: { type: "string" },
      property: { type: "string", multiple: true },
    },
  });
  const profileId = required(
    positionals[0],
    "<profileId>",
    "track identify",
    `${BIN} track identify user_123 --email a@b.com`,
  );

  const traits = {
    email: values.email,
    firstName: values["first-name"],
    lastName: values["last-name"],
    avatar: values.avatar,
  };
  const set = Object.entries(traits).filter(([, value]) => value !== undefined);
  const custom = properties(values.property, "track identify");
  if (set.length === 0 && !custom) {
    throw new AxiError("nothing to set on the profile", "VALIDATION_ERROR", [
      `Pass at least one of --email, --first-name, --last-name, --avatar, or --property`,
    ]);
  }

  await send("identify", {
    profileId,
    ...Object.fromEntries(set),
    ...(custom ? { properties: custom } : {}),
  });

  return {
    identified: profileId,
    set: [...set.map(([key]) => key), ...Object.keys(custom ?? {})].join(", "),
    note: "upsert — re-running with the same values changes nothing",
  };
}

const MORE_HELP = {
  adjust: helpFor({
    command: "track increment|decrement",
    description: "Move a numeric profile property by a step (not idempotent — it accumulates)",
    usage: `${BIN} track increment|decrement <profileId> <property> [--by <n>]`,
    flags: { "--by": "Step size (default 1)" },
    examples: [`${BIN} track increment user_123 credits --by 10`, `${BIN} track decrement user_123 credits`],
  }),
  alias: helpFor({
    command: "track alias",
    description: "Point an existing profile at another id, e.g. anonymous -> signed-in",
    usage: `${BIN} track alias <profileId> <alias>`,
    examples: [`${BIN} track alias anon_abc user_123`],
  }),
  group: helpFor({
    command: "track group",
    description: "Create or update a group (B2B: a company, team, or workspace)",
    usage: `${BIN} track group <id> --type <type> --name <name> [--property k=v]`,
    flags: {
      "--type": "Group type, e.g. company (required)",
      "--name": "Display name (required)",
      "--property": "A custom property as key=value (repeatable)",
    },
    examples: [`${BIN} track group acme --type company --name "Acme Inc"`],
  }),
  assign: helpFor({
    command: "track assign-group",
    description: "Link a profile to one or more groups",
    usage: `${BIN} track assign-group <profileId> <groupId> [<groupId>...]`,
    examples: [`${BIN} track assign-group user_123 acme`],
  }),
};

/** increment and decrement are the same payload with a different type. */
function adjust(type) {
  return async function run(argv) {
    if (wantsHelp(argv)) return MORE_HELP.adjust;
    const { positionals, values } = parse(argv, {
      command: `track ${type}`,
      flags: { by: { type: "string" } },
    });
    const profileId = required(positionals[0], "<profileId>", `track ${type}`, `${BIN} track ${type} user_123 credits`);
    const property = required(positionals[1], "<property>", `track ${type}`, `${BIN} track ${type} ${profileId} credits`);
    const value = positiveInt(values.by, "--by", 1);

    await send(type, { profileId, property, value });
    return {
      profile: profileId,
      property,
      [type === "increment" ? "increased_by" : "decreased_by"]: value,
      note: "accumulates — re-running moves the property again",
    };
  };
}

async function alias(argv) {
  if (wantsHelp(argv)) return MORE_HELP.alias;
  const { positionals } = parse(argv, { command: "track alias" });
  const profileId = required(positionals[0], "<profileId>", "track alias", `${BIN} track alias anon_abc user_123`);
  const aliasId = required(positionals[1], "<alias>", "track alias", `${BIN} track alias ${profileId} user_123`);
  await send("alias", { profileId, alias: aliasId });
  return { profile: profileId, alias: aliasId, note: "both ids now resolve to the same profile" };
}

async function group(argv) {
  if (wantsHelp(argv)) return MORE_HELP.group;
  const { values, positionals } = parse(argv, {
    command: "track group",
    flags: { type: { type: "string" }, name: { type: "string" }, property: { type: "string", multiple: true } },
  });
  const id = required(positionals[0], "<id>", "track group", `${BIN} track group acme --type company --name "Acme"`);
  const type = required(values.type, "--type", "track group", `${BIN} track group ${id} --type company --name "Acme"`);
  const name = required(values.name, "--name", "track group", `${BIN} track group ${id} --type ${type} --name "Acme"`);
  const custom = properties(values.property, "track group");

  await send("group", { id, type, name, ...(custom ? { properties: custom } : {}) });
  return { group: id, type, name, note: "upsert — re-running with the same values changes nothing" };
}

async function assignGroup(argv) {
  if (wantsHelp(argv)) return MORE_HELP.assign;
  const { positionals } = parse(argv, { command: "track assign-group" });
  const profileId = required(positionals[0], "<profileId>", "track assign-group", `${BIN} track assign-group user_123 acme`);
  const groupIds = positionals.slice(1);
  if (groupIds.length === 0) {
    throw new AxiError("at least one <groupId> is required", "VALIDATION_ERROR", [
      `Example: ${BIN} track assign-group ${profileId} acme`,
    ]);
  }
  await send("assign_group", { profileId, groupIds });
  return {
    profile: profileId,
    groups: groupIds,
    // Verified in the API docs: assignment does not backfill events.
    note: "groups are not added to past or future events automatically — pass --group on `track event`",
  };
}

export const trackCommand = makeDispatcher(
  "track",
  {
    event,
    identify,
    increment: adjust("increment"),
    decrement: adjust("decrement"),
    alias,
    group,
    "assign-group": assignGroup,
  },
  {
    summary: {
      event: "Record one event (not idempotent)",
      identify: "Create or update a user profile (upsert)",
      increment: "Raise a numeric profile property (accumulates)",
      decrement: "Lower a numeric profile property (accumulates)",
      alias: "Point one profile id at another",
      group: "Create or update a group (upsert)",
      "assign-group": "Link a profile to groups",
    },
  },
);
