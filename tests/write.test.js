import test from "node:test";
import assert from "node:assert/strict";
import { clientsCommand, projectsCommand, referencesCommand } from "../src/commands/manage.js";
import { trackCommand } from "../src/commands/track.js";
import { PROJECT, fails, mockOpenPanel, withClient } from "./helpers.js";

test.beforeEach(() => {
  withClient();
  delete process.env.OPENPANEL_WRITE_CLIENT_ID;
  delete process.env.OPENPANEL_WRITE_CLIENT_SECRET;
});

test("track event posts a typed payload and coerces property scalars", async () => {
  let sent;
  globalThis.fetch = async (url, init) => {
    sent = { url, method: init.method, body: JSON.parse(init.body), headers: init.headers };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const output = await trackCommand([
    "event",
    "deploy_finished",
    "--property",
    "service=api",
    "--property",
    "duration=42",
    "--property",
    "ok=true",
    "--profile",
    "user_1",
  ]);

  assert.equal(sent.method, "POST");
  assert.equal(sent.body.type, "track");
  assert.equal(sent.body.payload.name, "deploy_finished");
  assert.equal(sent.body.payload.profileId, "user_1");
  assert.deepEqual(sent.body.payload.properties, { service: "api", duration: 42, ok: true });
  assert.match(output.note, /records a second event/);
});

test("track prefers the write credentials when they are set", async () => {
  process.env.OPENPANEL_WRITE_CLIENT_ID = "writer";
  process.env.OPENPANEL_WRITE_CLIENT_SECRET = "writer-secret";
  let headers;
  globalThis.fetch = async (url, init) => {
    headers = init.headers;
    return { ok: true, status: 200, json: async () => ({}) };
  };
  await trackCommand(["event", "signup"]);
  assert.equal(headers["openpanel-client-id"], "writer");
});

test("a bare 200 with no body is a success, not a parse error", async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new Error("Unexpected end of JSON input");
    },
  });
  const output = await trackCommand(["event", "signup"]);
  assert.equal(output.tracked, "signup");
});

test("track refuses --project, which it cannot honour", async () => {
  const calls = mockOpenPanel({});
  await assert.rejects(() => trackCommand(["event", "signup", "--project", "other"]), (error) => {
    assert.equal(error.code, "VALIDATION_ERROR");
    assert.match(error.suggestions.join(" "), /write client/);
    return true;
  });
  assert.equal(calls.length, 0);
});

test("a malformed --property is rejected before the write", async () => {
  const calls = mockOpenPanel({});
  await assert.rejects(() => trackCommand(["event", "signup", "--property", "novalue"]), (error) => {
    assert.equal(error.code, "VALIDATION_ERROR");
    return true;
  });
  assert.equal(calls.length, 0);
});

test("identify requires something to set", async () => {
  const calls = mockOpenPanel({});
  await assert.rejects(() => trackCommand(["identify", "user_1"]), (error) => {
    assert.equal(error.code, "VALIDATION_ERROR");
    return true;
  });
  assert.equal(calls.length, 0);
});

test("identify maps the flag names onto the API's trait names", async () => {
  let sent;
  globalThis.fetch = async (url, init) => {
    sent = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({}) };
  };
  await trackCommand(["identify", "user_1", "--email", "a@b.com", "--first-name", "Ada"]);
  assert.equal(sent.type, "identify");
  assert.deepEqual(sent.payload, { profileId: "user_1", email: "a@b.com", firstName: "Ada" });
});

test("clients create defaults to read, not the API's write default", async () => {
  let sent;
  globalThis.fetch = async (url, init) => {
    sent = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { id: "c1", name: "agent", type: "read", secret: "sec_x" } }),
    };
  };
  const output = await clientsCommand(["create", "--name", "agent"]);

  assert.equal(sent.type, "read", "an omitted type must not silently create a write client");
  assert.equal(output.secret, "sec_x");
  assert.match(output.note, /shown once/);
});

test("clients create rejects an unknown type", async () => {
  const calls = mockOpenPanel({});
  await assert.rejects(() => clientsCommand(["create", "--name", "x", "--type", "admin"]), (error) => {
    assert.equal(error.code, "VALIDATION_ERROR");
    assert.match(error.suggestions.join(" "), /read, write, root/);
    return true;
  });
  assert.equal(calls.length, 0);
});

test("deleting a client that is already gone is a no-op", async () => {
  mockOpenPanel({ "/manage/clients/gone": fails(404, { error: "Not Found", message: "Client not found" }) });
  const output = await clientsCommand(["delete", "gone"]);
  assert.equal(output.unchanged, true);
  assert.equal(output.deleted, false);
});

test("clients list filters by project and never shows a secret", async () => {
  const calls = mockOpenPanel({
    "/manage/clients": { data: [{ id: "c1", name: "agent", type: "read", projectId: "p1" }] },
  });
  const output = await clientsCommand(["list", "--project", "p1"]);
  assert.equal(calls[0].query.projectId, "p1");
  assert.ok(!JSON.stringify(output).includes("secret:"));
});

test("track increment sends the profile, property, and step", async () => {
  let sent;
  globalThis.fetch = async (url, init) => {
    sent = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const output = await trackCommand(["increment", "user_1", "credits", "--by", "10"]);
  assert.equal(sent.type, "increment");
  assert.deepEqual(sent.payload, { profileId: "user_1", property: "credits", value: 10 });
  assert.match(output.note, /accumulates/);
});

test("track group upserts and assign-group warns that events are not backfilled", async () => {
  let sent;
  globalThis.fetch = async (url, init) => {
    sent = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({}) };
  };
  await trackCommand(["group", "acme", "--type", "company", "--name", "Acme Inc"]);
  assert.deepEqual(sent.payload, { id: "acme", type: "company", name: "Acme Inc" });

  const output = await trackCommand(["assign-group", "user_1", "acme", "beta"]);
  assert.deepEqual(sent.payload.groupIds, ["acme", "beta"]);
  assert.match(output.note, /not added to past or future events/);
});

test("projects create refuses an unknown type and never sends delete", async () => {
  const calls = mockOpenPanel({});
  await assert.rejects(() => projectsCommand(["create", "--name", "x", "--type", "mobile"]), (error) => {
    assert.match(error.suggestions.join(" "), /website, app, backend/);
    return true;
  });
  assert.equal(calls.length, 0);
});

test("projects update requires at least one change", async () => {
  const calls = mockOpenPanel({});
  await assert.rejects(() => projectsCommand(["update", "myblog"]), (error) => {
    assert.equal(error.code, "VALIDATION_ERROR");
    return true;
  });
  assert.equal(calls.length, 0);
});

test("there is no `projects delete` subcommand", async () => {
  await assert.rejects(() => projectsCommand(["delete", "myblog"]), (error) => {
    assert.match(error.message, /unknown subcommand/);
    assert.match(error.suggestions.join(" "), /list, create, update/);
    return true;
  });
});

test("references create needs a title and a time", async () => {
  const calls = mockOpenPanel({});
  await assert.rejects(() => referencesCommand(["create", "--title", "launch"]), (error) => {
    assert.equal(error.code, "VALIDATION_ERROR");
    return true;
  });
  assert.equal(calls.length, 0);

  let sent;
  globalThis.fetch = async (url, init) => {
    sent = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ data: { id: "r1", title: "launch" } }) };
  };
  await referencesCommand(["create", "--title", "launch", "--at", "2026-09-06T12:00:00Z"]);
  assert.equal(sent.projectId, PROJECT, "a reference is filed against the resolved project");
  assert.equal(sent.datetime, "2026-09-06T12:00:00Z");
});
