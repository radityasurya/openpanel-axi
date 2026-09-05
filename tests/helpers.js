export const PROJECT = "proj_test";
export const API = "https://openpanel.test/api";

/**
 * Stand in for the OpenPanel API. `routes` maps a path to a payload (or a
 * function of `{ query, headers }`). Returns the call log so a test can assert
 * what was — and was not — requested.
 */
export function mockOpenPanel(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    const path = parsed.pathname.replace("/api", "");
    const query = Object.fromEntries(parsed.searchParams);
    calls.push({ path, query, headers: init.headers });

    const route = routes[path];
    if (route === undefined) {
      return response(404, { error: "Not Found", message: `no route for ${path}` });
    }
    const value = typeof route === "function" ? route({ query, headers: init.headers }) : route;
    if (value?.__status) return response(value.__status, value.payload);
    return response(200, value);
  };
  return calls;
}

function response(status, payload) {
  return { ok: status < 400, status, json: async () => payload };
}

export function fails(status, payload) {
  return { __status: status, payload };
}

export function withClient() {
  process.env.OPENPANEL_CLIENT_ID = "test-client";
  process.env.OPENPANEL_CLIENT_SECRET = "test-secret";
  process.env.OPENPANEL_API_URL = API;
  process.env.OPENPANEL_PROJECT_ID = PROJECT;
}

export function withoutProject() {
  withClient();
  delete process.env.OPENPANEL_PROJECT_ID;
}

export const METRICS = {
  metrics: {
    bounce_rate: 41.2,
    unique_visitors: 120,
    total_sessions: 150,
    avg_session_duration: 62.5,
    total_screen_views: 380,
    views_per_session: 2.53,
    total_revenue: 0,
  },
  series: [
    { date: "2026-09-01T00:00:00.000Z", unique_visitors: 20, total_sessions: 25, total_screen_views: 60 },
    { date: "2026-09-02T00:00:00.000Z", unique_visitors: 18, total_sessions: 22, total_screen_views: 55 },
  ],
};
