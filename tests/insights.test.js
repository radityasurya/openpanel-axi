import test from "node:test";
import assert from "node:assert/strict";
import { AxiError } from "axi-sdk-js";
import {
  liveCommand,
  metricsCommand,
  pagesCommand,
  topCommand,
} from "../src/commands/insights.js";
import { API, METRICS, PROJECT, fails, mockOpenPanel, withClient, withoutProject } from "./helpers.js";

test.beforeEach(withClient);

test("metrics projects the rollup and defaults to a 7d window", async () => {
  const calls = mockOpenPanel({ [`/insights/${PROJECT}/metrics`]: METRICS });
  const output = await metricsCommand([]);

  assert.equal(calls[0].query.range, "7d");
  assert.equal(output.window, "7d");
  assert.equal(output.metrics.unique_visitors, 120);
  assert.equal(output.metrics.bounce_rate, 41.2);
  assert.ok(!("total_revenue" in output.metrics), "a zero revenue field is noise, not data");
  assert.ok(!("series" in output), "the series costs tokens and is opt-in");
});

test("metrics --series adds the per-interval breakdown", async () => {
  mockOpenPanel({ [`/insights/${PROJECT}/metrics`]: METRICS });
  const output = await metricsCommand(["--series"]);

  assert.equal(output.series.length, 2);
  assert.equal(output.series[0].date, "2026-09-01", "a daily bucket prints as a date");
});

test("metrics reports an empty window definitively", async () => {
  mockOpenPanel({
    [`/insights/${PROJECT}/metrics`]: { metrics: { total_sessions: 0 }, series: [] },
  });
  const output = await metricsCommand(["--range", "today"]);

  assert.match(output.metrics, /0 sessions/);
  assert.equal(output.window, "today");
});

test("an unknown --range is rejected before any request", async () => {
  const calls = mockOpenPanel({});
  await assert.rejects(() => metricsCommand(["--range", "last-week"]), (error) => {
    assert.ok(error instanceof AxiError);
    assert.equal(error.code, "VALIDATION_ERROR");
    assert.match(error.suggestions.join(" "), /monthToDate/);
    return true;
  });
  assert.equal(calls.length, 0);
});

test("a missing project never reaches the API", async () => {
  withoutProject();
  const calls = mockOpenPanel({});
  await assert.rejects(() => metricsCommand([]), (error) => {
    assert.equal(error.code, "VALIDATION_ERROR");
    return true;
  });
  assert.equal(calls.length, 0, "a placeholder project id would return an empty 200");
});

test("--project overrides the environment", async () => {
  const calls = mockOpenPanel({ "/insights/other/metrics": METRICS });
  await metricsCommand(["--project", "other"]);
  assert.equal(calls[0].path, "/insights/other/metrics");
});

test("pages hides origin for a single-domain project and reports the true total", async () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({
    origin: "https://example.com",
    path: `/p${index}`,
    sessions: 12 - index,
    pageviews: 20 - index,
  }));
  mockOpenPanel({ [`/insights/${PROJECT}/pages`]: rows });
  const output = await pagesCommand([]);

  assert.equal(output.count, "10 of 12 total");
  assert.ok(!("origin" in output.pages[0]));
  assert.match(output.help.join(" "), /--limit 12/);
});

test("pages keeps origin when a project tracks several domains", async () => {
  mockOpenPanel({
    [`/insights/${PROJECT}/pages`]: [
      { origin: "https://a.com", path: "/", sessions: 5, pageviews: 9 },
      { origin: "https://b.com", path: "/", sessions: 3, pageviews: 4 },
    ],
  });
  const output = await pagesCommand([]);
  assert.equal(output.pages[0].origin, "https://a.com", "path alone is ambiguous across domains");
});

test("top resolves a plural dimension and names empty values", async () => {
  const calls = mockOpenPanel({
    [`/insights/${PROJECT}/country`]: [
      { name: "SE", sessions: 9, pageviews: 20 },
      { name: null, sessions: 2, pageviews: 3 },
    ],
  });
  const output = await topCommand(["countries"]);

  assert.equal(calls[0].path, `/insights/${PROJECT}/country`);
  assert.equal(output.dimension, "country");
  assert.equal(output.values[1].name, "(none)");
});

test("top refuses an unknown dimension and lists the valid ones", async () => {
  const calls = mockOpenPanel({});
  await assert.rejects(() => topCommand(["continent"]), (error) => {
    assert.equal(error.code, "VALIDATION_ERROR");
    assert.match(error.suggestions.join(" "), /utm_campaign/);
    return true;
  });
  assert.equal(calls.length, 0);
});

test("live states zero explicitly", async () => {
  mockOpenPanel({ [`/insights/${PROJECT}/live`]: { visitors: 0 } });
  const output = await liveCommand([]);
  assert.match(output.live, /0 visitors/);
});

test("a write client's 401 explains the read-client requirement", async () => {
  mockOpenPanel({
    [`/insights/${PROJECT}/live`]: fails(401, { error: "Unauthorized", message: "Invalid client credentials" }),
  });
  await assert.rejects(() => liveCommand([]), (error) => {
    assert.equal(error.code, "AUTH_ERROR");
    assert.match(error.suggestions.join(" "), /read` or `root/);
    return true;
  });
});

test("a 404 points at the API base URL rather than the resource", async () => {
  mockOpenPanel({});
  await assert.rejects(() => liveCommand([]), (error) => {
    assert.equal(error.code, "NOT_FOUND");
    assert.match(error.suggestions.join(" "), new RegExp("OPENPANEL_API_URL"));
    return true;
  });
  assert.equal(API, "https://openpanel.test/api");
});
