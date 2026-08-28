/** Tier resolution, limit enforcement, and offline license validation. */
import test from "node:test";
import assert from "node:assert/strict";
import { useTempHome, rm } from "./helpers.js";

const home = useTempHome();

const { defaultConfig, saveConfig, currentMonth } = await import("../dist/config.js");
const {
  LIMITS,
  tierOf,
  limitsFor,
  licenseSummary,
  validateLicense,
  enforceQueryLimit,
  enforceVaultLimit,
  enforceConnectionLimit,
  LimitError,
  createCheckoutSession,
  claimLicenseFromSession,
  generateLicenseKey,
} = await import("../dist/license.js");

test.after(() => rm(home));

/** A config with an active license at the given tier. */
function licensed(tier, status = "active") {
  const cfg = defaultConfig();
  cfg.license = {
    key: `oa_live_${tier}_abcdefgh`,
    tier,
    status,
    checked_at: new Date().toISOString(),
  };
  return cfg;
}

test("the published price points match the landing page", () => {
  assert.equal(LIMITS.free.price, "$0");
  assert.equal(LIMITS.personal.price, "$19/mo");
  assert.equal(LIMITS.team.price, "$49/mo");
});

test("tierOf returns free unless the subscription is live", () => {
  assert.equal(tierOf(defaultConfig()), "free");
  assert.equal(tierOf(licensed("personal")), "personal");
  assert.equal(tierOf(licensed("team")), "team");
  assert.equal(tierOf(licensed("team", "trialing")), "team", "a trial gets full access");
  assert.equal(tierOf(licensed("team", "inactive")), "free", "a lapsed sub drops to free");
});

test("an active license that never recorded a tier is treated as personal", () => {
  assert.equal(tierOf(licensed("free")), "personal");
});

test("free tier stops at 50 queries a month", () => {
  const cfg = defaultConfig();
  cfg.usage = { month: currentMonth(), queries: 49, notes_created: 0, tokens: 0 };
  assert.doesNotThrow(() => enforceQueryLimit(cfg), "the 50th query is still allowed");

  cfg.usage.queries = 50;
  assert.throws(() => enforceQueryLimit(cfg), LimitError);
  assert.throws(() => enforceQueryLimit(cfg), /Free tier limit reached/);
});

test("last month's queries don't count against this month", () => {
  const cfg = defaultConfig();
  cfg.usage = { month: "2020-01", queries: 5000, notes_created: 0, tokens: 0 };
  assert.doesNotThrow(() => enforceQueryLimit(cfg));
});

test("paid tiers have no query ceiling", () => {
  for (const tier of ["personal", "team"]) {
    const cfg = licensed(tier);
    cfg.usage = { month: currentMonth(), queries: 1_000_000, notes_created: 0, tokens: 0 };
    assert.doesNotThrow(() => enforceQueryLimit(cfg));
    assert.equal(limitsFor(cfg).queries_per_month, Infinity);
  }
});

test("vault limits follow the tier", () => {
  const free = defaultConfig();
  assert.doesNotThrow(() => enforceVaultLimit(free), "the first vault is free");
  free.vaults = [{ name: "A", path: "/tmp/a", daily_notes_path: "", frontmatter_template: {} }];
  assert.throws(() => enforceVaultLimit(free), /Free tier allows 1 vault/i);

  const paid = licensed("personal");
  paid.vaults = [1, 2].map((n) => ({
    name: `V${n}`,
    path: `/tmp/v${n}`,
    daily_notes_path: "",
    frontmatter_template: {},
  }));
  assert.doesNotThrow(() => enforceVaultLimit(paid));
});

test("agent connection limits follow the tier", () => {
  const free = defaultConfig();
  free.agent_connections = [{ key: "k", name: "A", vault: "V", permissions: [], last_used: null }];
  assert.throws(() => enforceConnectionLimit(free), LimitError);

  const personal = licensed("personal");
  personal.agent_connections = new Array(50).fill({
    key: "k",
    name: "A",
    vault: "V",
    permissions: [],
    last_used: null,
  });
  assert.doesNotThrow(() => enforceConnectionLimit(personal), "personal is unlimited");

  const team = licensed("team");
  team.agent_connections = new Array(5).fill({
    key: "k",
    name: "A",
    vault: "V",
    permissions: [],
    last_used: null,
  });
  assert.throws(() => enforceConnectionLimit(team), /allows 5 agent connections/);
});

test("validateLicense with no key settles on free", async () => {
  const cfg = defaultConfig();
  saveConfig(cfg);
  const state = await validateLicense(cfg, { force: true });
  assert.equal(state.tier, "free");
  assert.equal(state.status, "inactive");
  assert.ok(state.checked_at, "the check is timestamped so we retry later");
});

test("without vendor credentials a well-formed key activates offline", async () => {
  const cfg = defaultConfig();
  cfg.license.key = "oa_live_team_a1b2c3d4e5";
  saveConfig(cfg);
  const state = await validateLicense(cfg, { force: true });
  assert.equal(state.status, "active", "a paying user keeps working on a plane");
  assert.equal(state.tier, "team");
});

test("a malformed key does not unlock a paid tier", async () => {
  for (const key of ["nonsense", "oa_live_enterprise_abcdefgh", "oa_live_team_short"]) {
    const cfg = defaultConfig();
    cfg.license.key = key;
    saveConfig(cfg);
    const state = await validateLicense(cfg, { force: true });
    assert.equal(state.status, "inactive", `"${key}" must not activate`);
    assert.equal(tierOf(cfg), "free");
  }
});

test("a fresh check is served from cache instead of re-hitting Stripe", async () => {
  const cfg = licensed("personal");
  saveConfig(cfg);
  const before = cfg.license.checked_at;
  const state = await validateLicense(cfg);
  assert.equal(state.checked_at, before, "cached result reused within the TTL");
});

test("licenseSummary reports unlimited as null, not Infinity", () => {
  // Infinity is not representable in JSON — it would serialize to null anyway.
  const summary = licenseSummary(licensed("personal"));
  assert.equal(summary.tier, "personal");
  assert.equal(summary.limits.queries_per_month, null);
  assert.equal(summary.limits.agent_connections, null);
  assert.equal(summary.key_present, true);

  const free = licenseSummary(defaultConfig());
  assert.equal(free.limits.queries_per_month, 50);
  assert.equal(free.key_present, false);
});

test("checkout fails loudly when Stripe is not configured", async () => {
  // Guards the ship-blocker: no silent half-working checkout.
  await assert.rejects(
    () => createCheckoutSession("personal", "http://localhost:3100"),
    /Stripe is not configured/,
  );
});

test("checkout fails loudly when the plan's price ID is missing", async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_placeholder_not_a_real_key";
  try {
    await assert.rejects(
      () => createCheckoutSession("team", "http://localhost:3100"),
      /No Stripe price configured for the team plan/,
    );
  } finally {
    delete process.env.STRIPE_SECRET_KEY;
  }
});

/* ------------------------- key issuance -------------------------- */

test("issued keys carry their tier and mode", () => {
  const personal = generateLicenseKey("personal", true);
  const team = generateLicenseKey("team", false);
  assert.match(personal, /^oa_live_personal_[0-9a-f]{32}$/);
  assert.match(team, /^oa_test_team_[0-9a-f]{32}$/);
  assert.notEqual(generateLicenseKey("personal", true), personal, "keys are random");
});

test("an issued key validates offline at the tier it was minted for", async () => {
  // The shape check is what a paying user falls back on with no network, so a
  // key we mint must survive it — otherwise checkout sells a dead key.
  for (const tier of ["personal", "team"]) {
    const cfg = defaultConfig();
    cfg.license.key = generateLicenseKey(tier, true);
    const state = await validateLicense(cfg, { force: true });
    assert.equal(state.status, "active");
    assert.equal(state.tier, tier);
  }
});

test("claiming a license fails loudly when Stripe is not configured", async () => {
  await assert.rejects(
    () => claimLicenseFromSession("cs_test_abc123"),
    /Stripe is not configured/,
  );
});

test("claiming rejects anything that is not a checkout session ID", async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_placeholder_not_a_real_key";
  try {
    for (const bad of ["", "sub_123", "cs_test_abc; DROP", "../../etc/passwd"]) {
      await assert.rejects(
        () => claimLicenseFromSession(bad),
        /does not look like a Stripe Checkout session ID/,
      );
    }
  } finally {
    delete process.env.STRIPE_SECRET_KEY;
  }
});
