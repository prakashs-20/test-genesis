// Node-native unit test for the Set Axira Claims Action. Runs with
// `node --test infra/auth0/genesis/actions/set-axira-claims.test.cjs`.
//
// Focus: the de-Genesis (Phase 4 / A5) guarantees:
//   1. products default to [] (NOT ["lending"]) when no source provides them
//   2. org metadata products win
//   3. AXIRA_DEFAULT_PRODUCTS secret (JSON or CSV) is honoured
//   4. tenant_id resolves from org metadata, else org_id (no fixed tenant)
//   5. no organization => Action skips (no claims stamped)
//   6. federated strategies are skipped (handled by resolve-axira-roles)
//   7. no organization BUT app_metadata.axira_tenant_id + roles =>
//      tenant_id + roles ARE stamped (founding-admin passwordless OTP grant
//      that does not surface event.organization)

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { onExecutePostLogin, __internal__ } = require("./set-axira-claims.cjs");
const { resolveProducts } = __internal__;

function makeApi() {
  const api = {
    accessClaims: {},
    idClaims: {},
  };
  api.accessToken = {
    setCustomClaim: (k, v) => {
      api.accessClaims[k] = v;
    },
  };
  api.idToken = {
    setCustomClaim: (k, v) => {
      api.idClaims[k] = v;
    },
  };
  return api;
}

const NS = "https://axira.ai/";

test("products default to [] when no org metadata and no secret (de-Genesis)", () => {
  const products = resolveProducts({ organization: {}, secrets: {} });
  assert.deepEqual(products, []);
});

test("org metadata products win", () => {
  const products = resolveProducts({
    organization: { metadata: { products: '["lending","compliance"]' } },
    secrets: { AXIRA_DEFAULT_PRODUCTS: '["edd"]' },
  });
  assert.deepEqual(products, ["lending", "compliance"]);
});

test("AXIRA_DEFAULT_PRODUCTS secret as JSON array is honoured", () => {
  const products = resolveProducts({
    organization: {},
    secrets: { AXIRA_DEFAULT_PRODUCTS: '["compliance"]' },
  });
  assert.deepEqual(products, ["compliance"]);
});

test("AXIRA_DEFAULT_PRODUCTS secret as CSV is honoured", () => {
  const products = resolveProducts({
    organization: {},
    secrets: { AXIRA_DEFAULT_PRODUCTS: "lending, compliance ,edd" },
  });
  assert.deepEqual(products, ["lending", "compliance", "edd"]);
});

test("tenant_id resolves from org metadata, else org_id", async () => {
  const api = makeApi();
  await onExecutePostLogin(
    {
      connection: { strategy: "auth0" },
      organization: {
        id: "org_abc",
        display_name: "Acme",
        metadata: { axira_tenant_id: "uuid-tenant-1" },
      },
      user: { user_id: "auth0|u1", email: "a@acme.com", app_metadata: {} },
      authorization: { roles: ["workspace-admin"] },
    },
    api,
  );
  assert.equal(api.accessClaims[`${NS}tenant_id`], "uuid-tenant-1");
  assert.deepEqual(api.accessClaims[`${NS}roles`], ["workspace-admin"]);
  // No hardcoded product literal: empty when nothing provides products.
  assert.deepEqual(api.accessClaims[`${NS}products`], []);

  const api2 = makeApi();
  await onExecutePostLogin(
    {
      connection: { strategy: "auth0" },
      organization: { id: "org_xyz", display_name: "Beta", metadata: {} },
      user: { user_id: "auth0|u2", email: "b@beta.com", app_metadata: {} },
      authorization: { roles: [] },
    },
    api2,
  );
  assert.equal(api2.accessClaims[`${NS}tenant_id`], "org_xyz");
});

test("no organization => Action skips (no claims stamped)", async () => {
  const api = makeApi();
  await onExecutePostLogin(
    {
      connection: { strategy: "auth0" },
      organization: undefined,
      user: { user_id: "auth0|u3", email: "c@c.com", app_metadata: {} },
    },
    api,
  );
  assert.deepEqual(api.accessClaims, {});
  assert.deepEqual(api.idClaims, {});
});

test("no organization but app_metadata tenant + roles => claims stamped (founding-admin OTP)", async () => {
  // The first-admin passwordless email-OTP grant does NOT reliably surface
  // event.organization to this Action. Without the app_metadata fallback the
  // founding workspace-admin would get a CLAIM-LESS token and Admin Hub would
  // reject them at /forbidden. axira_tenant_id + org_display_name + roles are
  // written to app_metadata at provisioning, so they are the source here.
  const api = makeApi();
  await onExecutePostLogin(
    {
      connection: { strategy: "email" },
      organization: undefined,
      user: {
        user_id: "email|founder@genesiscapital.com",
        email: "founder@genesiscapital.com",
        app_metadata: {
          axira_tenant_id: "uuid-tenant-founder",
          org_display_name: "Genesis Capital",
          roles: ["workspace-admin"],
        },
      },
      // No event.authorization (no org context) => roles come from app_metadata.
    },
    api,
  );
  assert.equal(api.accessClaims[`${NS}tenant_id`], "uuid-tenant-founder");
  assert.equal(api.idClaims[`${NS}tenant_id`], "uuid-tenant-founder");
  assert.equal(api.accessClaims[`${NS}tenant_name`], "Genesis Capital");
  assert.deepEqual(api.accessClaims[`${NS}roles`], ["workspace-admin"]);
  assert.deepEqual(api.idClaims[`${NS}roles`], ["workspace-admin"]);
});

test("federated strategy is skipped (handled by resolve-axira-roles)", async () => {
  const api = makeApi();
  await onExecutePostLogin(
    {
      connection: { strategy: "google-oauth2" },
      organization: { id: "org_abc", metadata: {} },
      user: { user_id: "auth0|u4", email: "d@d.com", app_metadata: {} },
    },
    api,
  );
  assert.deepEqual(api.accessClaims, {});
});

test("borrower portal_type + entity id are stamped from app_metadata", async () => {
  const api = makeApi();
  await onExecutePostLogin(
    {
      connection: { strategy: "email" },
      organization: { id: "org_b", display_name: "Borrowers", metadata: {} },
      user: {
        user_id: "auth0|borrower",
        email: "borrower@x.com",
        app_metadata: {
          portal_type: "customer",
          portal_entity_id: "auth0|borrower",
          roles: ["borrower"],
        },
      },
    },
    api,
  );
  assert.equal(api.accessClaims[`${NS}portal_type`], "customer");
  assert.equal(api.accessClaims[`${NS}portal_entity_id`], "auth0|borrower");
  assert.deepEqual(api.accessClaims[`${NS}roles`], ["borrower"]);
});
