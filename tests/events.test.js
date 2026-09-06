import test from "node:test";
import assert from "node:assert/strict";
import { eventsCommand } from "../src/commands/events.js";
import { projectsCommand } from "../src/commands/manage.js";
import { PROJECT, fails, mockOpenPanel, withClient } from "./helpers.js";

test.beforeEach(withClient);

const EVENT = {
  id: "e1",
  name: "screen_view",
  createdAt: "2026-09-05T10:00:00.000Z",
  path: "/pricing",
  origin: "https://example.com",
  country: "SE",
  device: "desktop",
  referrerName: "Google",
  properties: { plan: "pro" },
};

function listing(rows, totalCount, pages = 1, current = 1) {
  return { meta: { count: rows.length, totalCount, pages, current }, data: rows };
}

test("events reports the grand total, not just the page", async () => {
  const calls = mockOpenPanel({ "/export/events": listing([EVENT], 843, 43) });
  const output = await eventsCommand([]);

  assert.equal(calls[0].query.projectId, PROJECT);
  assert.equal(calls[0].query.limit, "20");
  assert.equal(output.count, "1 of 843 total");
  assert.equal(output.page, "1 of 43");
  assert.match(output.help.join(" "), /--page 2/);
});

test("events keeps properties out of the default schema", async () => {
  mockOpenPanel({ "/export/events": listing([EVENT], 1) });
  const bare = await eventsCommand([]);
  assert.ok(!("properties" in bare.events[0]));
  assert.equal(bare.events[0].referrer, "Google");

  mockOpenPanel({ "/export/events": listing([EVENT], 1) });
  const full = await eventsCommand(["--properties"]);
  assert.deepEqual(full.events[0].properties, { plan: "pro" });
});

test("repeated --event flags are sent as one filter, not the last one", async () => {
  const calls = mockOpenPanel({ "/export/events": listing([EVENT], 1) });
  await eventsCommand(["--event", "signup", "--event", "purchase"]);
  assert.equal(calls[0].query.event, "signup,purchase");
});

test("no matching events is a definitive answer", async () => {
  mockOpenPanel({ "/export/events": listing([], 0) });
  const output = await eventsCommand(["--event", "signup"]);
  assert.match(output.events, /0 events named signup matched/);
});

test("--limit rejects a non-integer before any request", async () => {
  const calls = mockOpenPanel({});
  await assert.rejects(() => eventsCommand(["--limit", "many"]), (error) => {
    assert.equal(error.code, "VALIDATION_ERROR");
    return true;
  });
  assert.equal(calls.length, 0);
});

test("projects lists ids and events counts", async () => {
  mockOpenPanel({
    "/manage/projects": {
      data: [{ id: "p1", name: "blog", domain: "example.com", eventsCount: 42 }],
    },
  });
  const output = await projectsCommand([]);
  assert.equal(output.projects[0].id, "p1");
  assert.equal(output.projects[0].events, 42);
});

test("projects explains that Manage is root-only when refused", async () => {
  mockOpenPanel({
    "/manage/projects": fails(401, { error: "Unauthorized", message: "Client is not root" }),
  });
  await assert.rejects(() => projectsCommand([]), (error) => {
    assert.equal(error.code, "AUTH_ERROR");
    assert.match(error.suggestions.join(" "), /root/);
    return true;
  });
});

test("--limit above the API cap is refused, not silently clamped", async () => {
  const calls = mockOpenPanel({});
  await assert.rejects(() => eventsCommand(["--limit", "5000"]), (error) => {
    assert.equal(error.code, "VALIDATION_ERROR");
    assert.match(error.suggestions.join(" "), /--page 2/);
    return true;
  });
  assert.equal(calls.length, 0);
});

test("events asks for the fields the API omits by default", async () => {
  const calls = mockOpenPanel({ "/export/events": listing([EVENT], 1) });
  await eventsCommand([]);
  assert.equal(
    calls[0].query.includes,
    "device,referrer",
    "device and referrer are null unless requested, and would print as empty",
  );
});
