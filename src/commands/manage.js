import { AxiError } from "axi-sdk-js";
import { op } from "../api.js";
import { BIN, helpFor, makeDispatcher, parse, required, wantsHelp } from "../args.js";

const CLIENT_TYPES = ["read", "write", "root"];

const HELP = {
  projects: helpFor({
    command: "projects",
    description: "List the projects this organization has, with their ids",
    usage: `${BIN} projects`,
    examples: [`${BIN} projects`],
  }),
  list: helpFor({
    command: "clients list",
    description: "List API clients and their types (secrets are never retrievable)",
    usage: `${BIN} clients list [--project <id>]`,
    flags: { "--project": "Only clients belonging to this project" },
    examples: [`${BIN} clients list`, `${BIN} clients list --project <id>`],
  }),
  create: helpFor({
    command: "clients create",
    description: "Create an API client and print its secret — the only time it is shown",
    usage: `${BIN} clients create --name <name> --type read|write|root [--project <id>]`,
    flags: {
      "--name": "Human-readable client name (required)",
      "--type": `One of ${CLIENT_TYPES.join(", ")} (default read)`,
      "--project": "Scope the client to one project; omit for an organization-wide client",
    },
    examples: [
      `${BIN} clients create --name "agent reads" --type read --project <id>`,
      `${BIN} clients create --name "ci writes" --type write --project <id>`,
    ],
  }),
  delete: helpFor({
    command: "clients delete",
    description: "Permanently delete an API client by id (already gone is a no-op)",
    usage: `${BIN} clients delete <id>`,
    examples: [`${BIN} clients delete <id>`],
  }),
};

export async function projectsCommand(argv) {
  if (wantsHelp(argv)) return HELP.projects;
  parse(argv, { command: "projects" });

  // Manage is the only surface that can enumerate projects, and it is root-only.
  // A read client's 401 is translated in api.js with the root explanation.
  const payload = await op("/manage/projects", {});
  const rows = payload?.data ?? [];

  if (rows.length === 0) {
    return {
      projects: "0 projects in this organization",
      help: ["Create one in the OpenPanel dashboard, then re-run"],
    };
  }
  return {
    count: `${rows.length} total`,
    projects: rows.map((project) => ({
      id: project.id,
      name: project.name,
      domain: project.domain || "-",
      events: project.eventsCount ?? 0,
    })),
    help: [
      `Run \`${BIN} metrics --project <id>\` to read one of them`,
      "Export OPENPANEL_PROJECT_ID to make one the default",
    ],
  };
}

async function list(argv) {
  if (wantsHelp(argv)) return HELP.list;
  const { values } = parse(argv, { command: "clients list" });
  const payload = await op("/manage/clients", { query: { projectId: values.project } });
  const rows = payload?.data ?? [];

  if (rows.length === 0) {
    return {
      clients: values.project
        ? `0 clients on project ${values.project}`
        : "0 clients in this organization",
      help: [`Run \`${BIN} clients create --name <name> --type read\` to make one`],
    };
  }
  return {
    count: `${rows.length} total`,
    clients: rows.map((client) => ({
      id: client.id,
      name: client.name,
      type: client.type,
      project: client.projectId || "(organization-wide)",
    })),
    help: [
      "Secrets are shown once at creation and are never retrievable",
      `Run \`${BIN} clients create --name <name> --type read --project <id>\` for a new one`,
    ],
  };
}

async function create(argv) {
  if (wantsHelp(argv)) return HELP.create;
  const { values } = parse(argv, {
    command: "clients create",
    flags: { name: { type: "string" }, type: { type: "string" } },
  });
  const name = required(
    values.name,
    "--name",
    "clients create",
    `${BIN} clients create --name "agent reads" --type read`,
  );
  // The API defaults an omitted type to `write`, which is the one type that
  // cannot read. Default to `read` here and reject anything unrecognised.
  const type = values.type ?? "read";
  if (!CLIENT_TYPES.includes(type)) {
    throw new AxiError(`unknown client type ${type}`, "VALIDATION_ERROR", [
      `valid types: ${CLIENT_TYPES.join(", ")}`,
      "`read` queries analytics, `write` ingests events, `root` does both plus Manage",
    ]);
  }

  const payload = await op("/manage/clients", {
    method: "POST",
    body: { name, type, ...(values.project ? { projectId: values.project } : {}) },
  });
  const client = payload?.data ?? {};

  return {
    client: {
      id: client.id,
      name: client.name,
      type: client.type,
      project: client.projectId || "(organization-wide)",
    },
    secret: client.secret,
    note: "the secret is shown once and cannot be retrieved again — store it now",
    help: [
      `export OPENPANEL_CLIENT_ID=${client.id}`,
      "export OPENPANEL_CLIENT_SECRET=<the secret above>",
    ],
  };
}

async function remove(argv) {
  if (wantsHelp(argv)) return HELP.delete;
  const { positionals } = parse(argv, { command: "clients delete" });
  const id = required(positionals[0], "<id>", "clients delete", `${BIN} clients delete <id>`);

  try {
    await op(`/manage/clients/${encodeURIComponent(id)}`, { method: "DELETE", allowEmpty: true });
  } catch (error) {
    // AXI §6: deleting something already gone is the desired state, not a failure.
    if (error.code === "NOT_FOUND") {
      return { client: id, deleted: false, unchanged: true, note: "no such client (no-op)" };
    }
    throw error;
  }
  return {
    client: id,
    deleted: true,
    note: "any integration still using this client's secret will now get 401",
  };
}

export const clientsCommand = makeDispatcher(
  "clients",
  { list, create, delete: remove },
  {
    fallback: "list",
    summary: {
      list: "List API clients and their types",
      create: "Create a client and print its secret once",
      delete: "Permanently delete a client by id",
    },
  },
);
