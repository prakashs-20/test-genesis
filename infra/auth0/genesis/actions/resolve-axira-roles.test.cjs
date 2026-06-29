// Node-native unit test for the Auth0 Action. No vitest/jest — runs with
// plain `node --test infra/auth0/genesis/actions/resolve-axira-roles.test.cjs`
// so it doesn't pull the Action into a TS-aware test runner. Auth0 itself
// runs the Action in a stripped-down Node sandbox, so we mimic that.
//
// "Federated-Okta one login": the federated branch resolves the Axira role
// projection from event.connection.metadata (the tenant baseline) + the
// per-user event.user.app_metadata — NO inbound call to the (private)
// gateway, NO M2M token. We assert there is zero fetch on every path.
//
// What we exercise:
//   1. app_metadata override (roles non-empty) → claims stamped, conn ignored
//   a. connection baseline default_role (no app roles) → roles=[default_role]
//   b. connection group_role_map + user.groups match → mapped roles
//   c. app_metadata override WINS over connection baseline + group map
//   disabled. app_metadata.disabled:true → deny ("disabled")
//   no-tenant. neither source has tenant_id → deny ("not finished setting up")
//   pre-wizard. conn has tenant but NO default_role, no app roles → deny
//               ("not finished setting up") — the server-side wizard gate
//   5. Native DB user (strategy='auth0') → Action skips, no calls
//   6. Passwordless email (strategy='email') → Action skips, no calls
//   7. Social strategy → denied when SOCIAL_LOGIN_ENABLED unset
//   8. Social strategy → skipped (not denied) when SOCIAL_LOGIN_ENABLED=true
//   9. NO fetch is ever made (gateway is never called)
//  10. mapGroupsToRoles unit cases (name + id match, case-insensitive, dedupe)

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  onExecutePostLogin,
  mapGroupsToRoles,
} = require("./resolve-axira-roles.cjs");

function makeApi() {
  return {
    accessClaims: {},
    idClaims: {},
    denied: null,
    accessToken: {
      setCustomClaim: function (k, v) {
        this.parent.accessClaims[k] = v;
      },
    },
    idToken: {
      setCustomClaim: function (k, v) {
        this.parent.idClaims[k] = v;
      },
    },
    access: {
      deny: function (reason) {
        this.parent.denied = reason;
      },
    },
  };
}

function wire(api) {
  api.accessToken.parent = api;
  api.idToken.parent = api;
  api.access.parent = api;
  return api;
}

// Base federated event. By default the per-user app_metadata carries the
// full projection (the override path). Tests that exercise the connection
// baseline pass an empty app_metadata + a populated connection.metadata.
function makeEvent(overrides = {}) {
  return {
    connection: {
      name: "okta-acme",
      strategy: "okta-workforce",
      metadata: {},
      ...overrides.connection,
    },
    user: {
      email: "ravi@acme.bank",
      user_id: "okta|okta-acme|00uABC123",
      identities: [{ user_id: "00uABC123" }],
      groups: [],
      app_metadata: {
        axira_tenant_id: "TID",
        roles: ["underwriter"],
        portal_type: "internal",
        aaid: "UID",
      },
      ...overrides.user,
    },
    secrets: {
      ...overrides.secrets,
    },
    ...overrides,
  };
}

/**
 * Install a fetch spy that FAILS the test if the Action ever calls it.
 * The federated read path must never reach out to the gateway (or any
 * network) at login.
 */
function guardNoFetch() {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(url);
    throw new Error(
      `Action must not call fetch — reads connection.metadata + app_metadata (got ${url})`,
    );
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = orig;
    },
  };
}

test("1) app_metadata override → stamps claims on access + id tokens (no fetch)", async () => {
  const api = wire(makeApi());
  const fetchGuard = guardNoFetch();
  try {
    await onExecutePostLogin(makeEvent(), api);
  } finally {
    fetchGuard.restore();
  }

  assert.equal(api.denied, null, "should not deny on resolved");
  assert.deepEqual(api.accessClaims, {
    "https://axira.ai/tenant_id": "TID",
    "https://axira.ai/roles": ["underwriter"],
    "https://axira.ai/portal_type": "internal",
    "https://axira.ai/aaid": "UID",
  });
  assert.deepEqual(api.idClaims, {
    "https://axira.ai/tenant_id": "TID",
    "https://axira.ai/roles": ["underwriter"],
    "https://axira.ai/portal_type": "internal",
    "https://axira.ai/aaid": "UID",
  });
  assert.equal(fetchGuard.calls.length, 0, "no gateway call at login");
});

test("a) connection baseline default_role (no app roles) → roles=[default_role]", async () => {
  const api = wire(makeApi());
  const fetchGuard = guardNoFetch();
  try {
    await onExecutePostLogin(
      makeEvent({
        connection: {
          metadata: {
            axira_tenant_id: "TID-CONN",
            axira_portal_type: "internal",
            axira_default_role: "viewer",
          },
        },
        // Brand-new Okta user: no per-user projection yet.
        user: { app_metadata: {}, groups: [] },
      }),
      api,
    );
  } finally {
    fetchGuard.restore();
  }
  assert.equal(api.denied, null, "default_role should land the user");
  assert.deepEqual(api.accessClaims, {
    "https://axira.ai/tenant_id": "TID-CONN",
    "https://axira.ai/roles": ["viewer"],
    "https://axira.ai/portal_type": "internal",
  });
  assert.deepEqual(api.idClaims, {
    "https://axira.ai/tenant_id": "TID-CONN",
    "https://axira.ai/roles": ["viewer"],
    "https://axira.ai/portal_type": "internal",
  });
  assert.equal(fetchGuard.calls.length, 0);
});

test("b) connection group_role_map + user.groups match → mapped roles", async () => {
  const api = wire(makeApi());
  const fetchGuard = guardNoFetch();
  try {
    await onExecutePostLogin(
      makeEvent({
        connection: {
          metadata: {
            axira_tenant_id: "TID-CONN",
            axira_portal_type: "internal",
            axira_default_role: "viewer",
            axira_group_role_map: JSON.stringify({
              underwriters: ["underwriter"],
              "00gADMIN": ["workspace-admin"],
            }),
          },
        },
        // Groups claim carries a NAME and an Okta group id; both resolve.
        user: {
          app_metadata: {},
          groups: ["Underwriters", "00gADMIN"],
        },
      }),
      api,
    );
  } finally {
    fetchGuard.restore();
  }
  assert.equal(api.denied, null);
  assert.deepEqual(api.accessClaims["https://axira.ai/roles"], [
    "underwriter",
    "workspace-admin",
  ]);
  assert.equal(api.accessClaims["https://axira.ai/tenant_id"], "TID-CONN");
  assert.equal(fetchGuard.calls.length, 0);
});

test("c) app_metadata override WINS over connection baseline + group map", async () => {
  const api = wire(makeApi());
  const fetchGuard = guardNoFetch();
  try {
    await onExecutePostLogin(
      makeEvent({
        connection: {
          metadata: {
            axira_tenant_id: "TID-CONN",
            axira_portal_type: "internal",
            axira_default_role: "viewer",
            axira_group_role_map: JSON.stringify({
              admins: ["workspace-admin"],
            }),
          },
        },
        user: {
          app_metadata: {
            axira_tenant_id: "TID-USER",
            roles: ["loan-officer"],
            portal_type: "internal",
          },
          groups: ["Admins"],
        },
      }),
      api,
    );
  } finally {
    fetchGuard.restore();
  }
  assert.equal(api.denied, null);
  // app_metadata wins: tenant + roles come from the per-user projection,
  // NOT the connection baseline or the group map.
  assert.deepEqual(api.accessClaims["https://axira.ai/roles"], [
    "loan-officer",
  ]);
  assert.equal(api.accessClaims["https://axira.ai/tenant_id"], "TID-USER");
  assert.equal(fetchGuard.calls.length, 0);
});

test("disabled) app_metadata.disabled:true → access.deny with disabled message", async () => {
  const api = wire(makeApi());
  const fetchGuard = guardNoFetch();
  try {
    await onExecutePostLogin(
      makeEvent({
        connection: {
          metadata: {
            axira_tenant_id: "TID-CONN",
            axira_default_role: "viewer",
          },
        },
        user: {
          app_metadata: {
            axira_tenant_id: "TID",
            roles: ["underwriter"],
            disabled: true,
          },
        },
      }),
      api,
    );
  } finally {
    fetchGuard.restore();
  }
  assert.match(api.denied ?? "", /disabled/i);
  assert.deepEqual(api.accessClaims, {});
  assert.equal(fetchGuard.calls.length, 0);
});

test("no-tenant) neither app_metadata nor connection has tenant_id → deny (not finished setting up)", async () => {
  const api = wire(makeApi());
  const fetchGuard = guardNoFetch();
  try {
    await onExecutePostLogin(
      makeEvent({
        connection: { metadata: {} },
        user: { app_metadata: { roles: ["underwriter"] }, groups: [] },
      }),
      api,
    );
  } finally {
    fetchGuard.restore();
  }
  assert.match(api.denied ?? "", /not finished setting up/i);
  assert.deepEqual(api.accessClaims, {});
  assert.equal(fetchGuard.calls.length, 0);
});

test("pre-wizard) connection has tenant but NO default_role, no app roles → deny (not finished setting up)", async () => {
  const api = wire(makeApi());
  const fetchGuard = guardNoFetch();
  try {
    await onExecutePostLogin(
      makeEvent({
        // The platform writes axira_tenant_id to the connection at provision,
        // but axira_default_role ONLY at wizard-complete. A tenant present
        // without a default_role baseline is the pre-wizard state.
        connection: { metadata: { axira_tenant_id: "TID-CONN" } },
        user: { app_metadata: {}, groups: [] },
      }),
      api,
    );
  } finally {
    fetchGuard.restore();
  }
  assert.match(api.denied ?? "", /not finished setting up/i);
  assert.deepEqual(api.accessClaims, {});
  assert.equal(fetchGuard.calls.length, 0);
});

test("5) native DB user → Action skips entirely (no fetch, no deny)", async () => {
  const api = wire(makeApi());
  const event = makeEvent({
    connection: { name: "Username-Password-Authentication", strategy: "auth0" },
  });
  const fetchGuard = guardNoFetch();
  try {
    await onExecutePostLogin(event, api);
  } finally {
    fetchGuard.restore();
  }
  assert.equal(api.denied, null);
  assert.deepEqual(api.accessClaims, {});
  assert.equal(fetchGuard.calls.length, 0);
});

test("6) passwordless email → Action skips entirely (no fetch, no deny)", async () => {
  const api = wire(makeApi());
  const event = makeEvent({
    connection: { name: "email", strategy: "email" },
  });
  const fetchGuard = guardNoFetch();
  try {
    await onExecutePostLogin(event, api);
  } finally {
    fetchGuard.restore();
  }
  assert.equal(api.denied, null);
  assert.deepEqual(api.accessClaims, {});
  assert.equal(fetchGuard.calls.length, 0);
});

// ── Okta-only: social login disabled (Phase 4 / Chunk B) ──────────────

test("7) social strategy denied when SOCIAL_LOGIN_ENABLED unset (default off)", async () => {
  const api = wire(makeApi());
  const event = makeEvent({
    connection: { name: "google-oauth2", strategy: "google-oauth2" },
    // secrets has no SOCIAL_LOGIN_ENABLED → social disabled by default.
  });
  const fetchGuard = guardNoFetch();
  try {
    await onExecutePostLogin(event, api);
  } finally {
    fetchGuard.restore();
  }
  assert.match(api.denied ?? "", /social sign-in is not available/i);
  assert.deepEqual(api.accessClaims, {});
  assert.equal(fetchGuard.calls.length, 0);
});

test("8) social strategy skipped (not denied) when SOCIAL_LOGIN_ENABLED=true", async () => {
  const api = wire(makeApi());
  const event = makeEvent({
    connection: { name: "google-oauth2", strategy: "google-oauth2" },
    secrets: { SOCIAL_LOGIN_ENABLED: "true" },
  });
  const fetchGuard = guardNoFetch();
  try {
    await onExecutePostLogin(event, api);
  } finally {
    fetchGuard.restore();
  }
  // Enabled: resolve-roles skips social (its own claim path); no deny.
  assert.equal(api.denied, null);
  assert.equal(fetchGuard.calls.length, 0);
});

// ── mapGroupsToRoles unit cases ───────────────────────────────────────

test("10) mapGroupsToRoles: name + id match, case-insensitive, de-duplicated", () => {
  const mapJson = JSON.stringify({
    underwriters: ["underwriter"],
    "00gADMIN": ["workspace-admin", "underwriter"],
  });
  // Name match (different case) + id match; "underwriter" appears via both
  // groups but is de-duplicated.
  assert.deepEqual(mapGroupsToRoles(["UNDERWRITERS", "00gadmin"], mapJson), [
    "underwriter",
    "workspace-admin",
  ]);
  // No groups → [].
  assert.deepEqual(mapGroupsToRoles([], mapJson), []);
  // Unmapped group → [].
  assert.deepEqual(mapGroupsToRoles(["nobody"], mapJson), []);
  // Missing / malformed map JSON → [] (never throws).
  assert.deepEqual(mapGroupsToRoles(["underwriters"], undefined), []);
  assert.deepEqual(mapGroupsToRoles(["underwriters"], "{not json"), []);
  // Non-array groups → [].
  assert.deepEqual(mapGroupsToRoles("underwriters", mapJson), []);
});
