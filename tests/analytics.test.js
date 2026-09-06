import test from "node:test";
import assert from "node:assert/strict";
import {
  activeUsersCommand,
  flowCommand,
  funnelCommand,
} from "../src/commands/analytics.js";
import { eventsCommand } from "../src/commands/events.js";
import { pagesCommand } from "../src/commands/insights.js";
import { gscCommand } from "../src/commands/gsc.js";
import { profilesCommand, sessionsCommand } from "../src/commands/people.js";
import { PROJECT, mockOpenPanel, withClient } from "./helpers.js";

test.beforeEach(withClient);

test("funnel sends steps as repeated parameters", async () => {
  const calls = mockOpenPanel({
    [`/insights/${PROJECT}/funnel`]: {
      totalUsers: 75,
      completedUsers: 30,
      overallConversionRate: 40,
      steps: [
        { step: 1, eventName: "view", users: 75, conversionRateFromStart: 100, dropoffPercent: 0 },
        { step: 2, eventName: "buy", users: 30, conversionRateFromStart: 40, dropoffPercent: 60, isHighestDropoff: true },
      ],
    },
  });
  const output = await funnelCommand(["view", "buy"]);

  assert.deepEqual(calls[0].queryAll.steps, ["view", "buy"], "a comma-joined step list is rejected upstream");
  assert.equal(output.conversion, "40%");
  assert.match(output.biggest_dropoff, /buy/);
});

test("funnel needs between 2 and 10 events, checked before the request", async () => {
  const calls = mockOpenPanel({});
  await assert.rejects(() => funnelCommand(["only_one"]), (error) => {
    assert.equal(error.code, "VALIDATION_ERROR");
    return true;
  });
  assert.equal(calls.length, 0);
});

test("a final step with no drop-off prints a dash, not null%", async () => {
  mockOpenPanel({
    [`/insights/${PROJECT}/funnel`]: {
      totalUsers: 5,
      completedUsers: 5,
      overallConversionRate: 100,
      steps: [{ step: 1, eventName: "a", users: 5, conversionRateFromStart: 100, dropoffPercent: null }],
    },
  });
  const output = await funnelCommand(["a", "b"]);
  assert.equal(output.steps[0].dropoff, "-");
});

test("flow between two events requires the destination", async () => {
  const calls = mockOpenPanel({});
  await assert.rejects(() => flowCommand(["signup", "--mode", "between"]), (error) => {
    assert.match(error.suggestions.join(" "), /--end/);
    return true;
  });
  assert.equal(calls.length, 0);
});

test("flow reports edges, not the sankey layout", async () => {
  mockOpenPanel({
    [`/insights/${PROJECT}/user_flow`]: {
      nodes: [{ id: "n1", label: "screen_view" }, { id: "n2", label: "signup" }],
      links: [{ source: "n1", target: "n2", value: 12 }],
    },
  });
  const output = await flowCommand(["screen_view"]);
  assert.deepEqual(output.paths, [{ from: "screen_view", to: "signup", sessions: 12 }]);
});

test("active-users refuses a window past the API's 90-day cap", async () => {
  const calls = mockOpenPanel({});
  await assert.rejects(() => activeUsersCommand(["--days", "120"]), (error) => {
    assert.equal(error.code, "VALIDATION_ERROR");
    return true;
  });
  assert.equal(calls.length, 0);
});

test("pages performance reports the API's own total and validates --sort", async () => {
  mockOpenPanel({
    [`/insights/${PROJECT}/pages/performance`]: {
      total_pages: 12,
      shown: 1,
      pages: [{ path: "/", sessions: 25, pageviews: 36, bounce_rate: 60.004, avg_duration: 5.4 }],
    },
  });
  const output = await pagesCommand(["performance"]);
  assert.equal(output.count, "1 of 12 total");
  assert.equal(output.pages[0].bounce_rate, 60);

  const calls = mockOpenPanel({});
  await assert.rejects(() => pagesCommand(["performance", "--sort", "clicks"]), (error) => {
    assert.match(error.suggestions.join(" "), /bounce_rate/);
    return true;
  });
  assert.equal(calls.length, 0);
});

test("pages entry and exit share one endpoint with a mode", async () => {
  const calls = mockOpenPanel({
    [`/insights/${PROJECT}/pages/entry_exit`]: [{ path: "/", sessions: 23, pageviews: 58 }],
  });
  const output = await pagesCommand(["exit"]);
  assert.equal(calls[0].query.mode, "exit");
  assert.equal(output.exit_pages[0].path, "/");
});

test("events names handles the bare string array the API returns", async () => {
  mockOpenPanel({ [`/insights/${PROJECT}/events/names`]: ["screen_view", "link_out"] });
  const output = await eventsCommand(["names"]);
  assert.deepEqual(output.events, ["screen_view", "link_out"]);
});

test("events properties uses the eventName key, not event", async () => {
  const calls = mockOpenPanel({
    [`/insights/${PROJECT}/events/properties`]: { columns: ["path"], properties: [] },
  });
  await eventsCommand(["properties", "screen_view"]);
  assert.equal(calls[0].query.eventName, "screen_view", "/export/events uses `event`; insights uses `eventName`");
});

test("profiles and sessions are projected down from their wide payloads", async () => {
  mockOpenPanel({
    [`/insights/${PROJECT}/profiles`]: [
      { id: "p1", first_name: "Ada", last_name: "L", email: "a@b.c", last_seen_at: "2026-09-05T13:53:57.000Z" },
    ],
  });
  const profiles = await profilesCommand([]);
  assert.equal(profiles.profiles[0].name, "Ada L");
  assert.equal(profiles.profiles[0].last_seen, "2026-09-05 13:53:57");

  mockOpenPanel({
    [`/insights/${PROJECT}/sessions`]: [
      { id: "s1", created_at: "2026-09-02T00:17:22.000Z", duration: 15400, screen_view_count: 2, is_bounce: false, entry_path: "/", exit_path: "/contact", country: "US", device: "desktop" },
    ],
  });
  const sessions = await sessionsCommand([]);
  assert.equal(sessions.sessions[0].duration_s, 15, "duration arrives in milliseconds");
  assert.equal(sessions.bounced, "0 of 1");
});

test("a plain-text 500 from gsc reports the missing integration, not a parse error", async () => {
  globalThis.fetch = async () => ({
    ok: false,
    status: 500,
    json: async () => {
      throw new Error("Unexpected token I");
    },
  });
  await assert.rejects(() => gscCommand(["overview"]), (error) => {
    assert.match(error.message, /Search Console/);
    assert.match(error.suggestions.join(" "), /OAuth/);
    return true;
  });
});

test("gsc sends date-only bounds and never a range", async () => {
  const calls = mockOpenPanel({ [`/insights/${PROJECT}/gsc/queries`]: [{ query: "a", clicks: 1, impressions: 9, ctr: 0.111, position: 18.555 }] });
  const output = await gscCommand(["queries", "--range", "30d"]);

  // `range=` makes the server derive '2026-08-07 00:00:00', which ClickHouse
  // refuses to compare against the GSC table's Date column — a hard 500.
  assert.equal(calls[0].query.range, undefined, "forwarding range to a gsc route 500s upstream");
  assert.match(calls[0].query.startDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(calls[0].query.endDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(output.queries[0].ctr, "11.1%", "ctr arrives as a fraction");
  assert.equal(output.queries[0].position, 18.6);
});

test("gsc rejects a range it cannot convert to dates", async () => {
  const calls = mockOpenPanel({});
  await assert.rejects(() => gscCommand(["queries", "--range", "monthToDate"]), (error) => {
    assert.equal(error.code, "VALIDATION_ERROR");
    return true;
  });
  assert.equal(calls.length, 0);
});

test("gsc detail views summarise the series instead of dumping 91 rows", async () => {
  const timeseries = Array.from({ length: 91 }, (_, day) => ({
    date: `2026-06-${String((day % 28) + 1).padStart(2, "0")}`,
    clicks: day === 0 ? 2 : 0,
    impressions: day < 4 ? 16 : 0,
    ctr: 0,
    position: day < 4 ? 8.8 : 0,
  }));
  mockOpenPanel({
    [`/insights/${PROJECT}/gsc/pages/details`]: {
      timeseries,
      queries: [{ query: "a", clicks: 0, impressions: 1, ctr: 0, position: 12 }],
    },
  });

  const output = await gscCommand(["page", "https://example.com/about"]);
  assert.equal(output.totals.clicks, 2);
  assert.equal(output.totals.impressions, 64);
  assert.equal(output.totals.ctr, "3.1%");
  // Zero-position days are days the page never ranked; averaging them in would
  // report a better position than the page actually held.
  assert.equal(output.totals.avg_position, 8.8);
  assert.equal(output.series, "91 daily points not shown", "the series is named with its size, not omitted");
  assert.match(output.help.join(" "), /--series/);
});

test("gsc --series opts back into the full breakdown", async () => {
  mockOpenPanel({
    [`/insights/${PROJECT}/gsc/queries/details`]: {
      timeseries: [{ date: "2026-06-01", clicks: 1, impressions: 2, ctr: 0.5, position: 3 }],
      pages: [],
    },
  });
  const output = await gscCommand(["query", "something", "--series"]);
  assert.equal(output.series.length, 1);
  assert.equal(output.series[0].ctr, "50.0%");
  assert.match(output.pages, /0 pages recorded/);
});
