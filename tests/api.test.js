import test from "node:test";
import assert from "node:assert/strict";
import { baseUrl, credentials, op, resolveProject } from "../src/api.js";
import { API, PROJECT, fails, mockOpenPanel, withClient } from "./helpers.js";

test.beforeEach(withClient);

test("baseUrl defaults to the cloud API and trims a trailing slash", () => {
  assert.equal(baseUrl({}), "https://api.openpanel.dev");
  assert.equal(baseUrl({ OPENPANEL_API_URL: `${API}/` }), API);
});

test("credentials fail loud with the setup steps", () => {
  assert.throws(() => credentials({}), (error) => {
    assert.equal(error.code, "AUTH_REQUIRED");
    assert.match(error.suggestions.join(" "), /Settings -> API Clients/);
    return true;
  });
});

test("the client id and secret travel as headers", async () => {
  const calls = mockOpenPanel({ "/insights/x/live": { visitors: 1 } });
  await op("/insights/x/live", {});
  assert.equal(calls[0].headers["openpanel-client-id"], "test-client");
  assert.equal(calls[0].headers["openpanel-client-secret"], "test-secret");
});

test("empty query values are dropped rather than sent blank", async () => {
  const calls = mockOpenPanel({ "/insights/x/pages": [] });
  await op("/insights/x/pages", { query: { range: "7d", startDate: undefined, endDate: "" } });
  assert.deepEqual(calls[0].query, { range: "7d" });
});

test("resolveProject prefers the flag, then the environment", () => {
  assert.equal(resolveProject("flag"), "flag");
  assert.equal(resolveProject(undefined), PROJECT);
  assert.throws(() => resolveProject(undefined, {}), (error) => {
    assert.equal(error.code, "VALIDATION_ERROR");
    return true;
  });
});

test("a 429 is reported as rate limiting, with the window", async () => {
  mockOpenPanel({
    "/insights/x/live": fails(429, { error: "Too Many Requests", message: "You have exceeded the rate limit" }),
  });
  await assert.rejects(() => op("/insights/x/live", {}), (error) => {
    assert.equal(error.code, "RATE_LIMITED");
    assert.match(error.suggestions.join(" "), /100 requests per 10 seconds/);
    return true;
  });
});

test("a dashboard URL mistaken for the API surfaces as a non-JSON response", async () => {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new Error("not json"); } });
  await assert.rejects(() => op("/insights/x/live", {}), (error) => {
    assert.equal(error.code, "API_ERROR");
    assert.match(error.suggestions.join(" "), /not the dashboard/);
    return true;
  });
});

test("an unreachable host is a network error, not an API error", async () => {
  globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };
  await assert.rejects(() => op("/insights/x/live", {}), (error) => {
    assert.equal(error.code, "NETWORK_ERROR");
    assert.match(error.suggestions.join(" "), new RegExp(API));
    return true;
  });
});
