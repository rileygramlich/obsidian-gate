/**
 * Stripe license validation.
 *
 * The connector runs entirely on the user's machine, so licensing is a startup
 * check, not a gate on every call: validate the key, cache the tier in the
 * local config, and fall back to the free tier if the network is down.
 */
import crypto from "node:crypto";
import Stripe from "stripe";
import {
  currentMonth,
  saveConfig,
  type Config,
  type LicenseState,
} from "./config.js";

export type Tier = "free" | "personal" | "team";

export interface TierLimits {
  label: string;
  price: string;
  queries_per_month: number; // Infinity for paid tiers
  vaults: number;
  agent_connections: number;
}

export const LIMITS: Record<Tier, TierLimits> = {
  free: {
    label: "Free",
    price: "$0",
    queries_per_month: 50,
    vaults: 1,
    agent_connections: 1,
  },
  personal: {
    label: "Personal",
    price: "$19/mo",
    queries_per_month: Infinity,
    vaults: 3,
    agent_connections: Infinity,
  },
  team: {
    label: "Team",
    price: "$49/mo",
    queries_per_month: Infinity,
    vaults: 3,
    agent_connections: 5,
  },
};

/** Re-check with Stripe at most once a day; cached result is used in between. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function stripeClient(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return new Stripe(key);
}

export function tierOf(cfg: Config): Tier {
  const { license } = cfg;
  if (license.status === "active" || license.status === "trialing") {
    return license.tier === "free" ? "personal" : license.tier;
  }
  return "free";
}

export function limitsFor(cfg: Config): TierLimits {
  return LIMITS[tierOf(cfg)];
}

/**
 * Offline shape check. Keys we issue look like `oa_live_<tier>_<random>`;
 * this lets a paying user keep working on a plane.
 */
function parseKeyShape(key: string): { valid: boolean; tier: Tier } {
  const m = /^oa_(live|test)_(personal|team)_[A-Za-z0-9]{8,}$/.exec(key.trim());
  if (!m) return { valid: false, tier: "free" };
  return { valid: true, tier: m[2] as Tier };
}

/**
 * Validate the configured license key and persist the result.
 * Never throws — a licensing hiccup should degrade to free, not crash the server.
 */
export async function validateLicense(
  cfg: Config,
  opts: { force?: boolean } = {},
): Promise<LicenseState> {
  const key = cfg.license.key;
  if (!key) {
    cfg.license = { ...cfg.license, tier: "free", status: "inactive", checked_at: new Date().toISOString() };
    saveConfig(cfg);
    return cfg.license;
  }

  const lastChecked = cfg.license.checked_at
    ? Date.parse(cfg.license.checked_at)
    : 0;
  const fresh = Date.now() - lastChecked < CACHE_TTL_MS;
  if (fresh && !opts.force && cfg.license.status !== "inactive") {
    return cfg.license;
  }

  const shape = parseKeyShape(key);
  const stripe = stripeClient();

  if (!stripe) {
    // No vendor credentials on this machine: trust the key shape.
    cfg.license = {
      ...cfg.license,
      tier: shape.tier,
      status: shape.valid ? "active" : "inactive",
      checked_at: new Date().toISOString(),
    };
    saveConfig(cfg);
    return cfg.license;
  }

  try {
    const subs = await stripe.subscriptions.search({
      query:
        `metadata['license_key']:'${key.replace(/'/g, "")}' AND ` +
        `(status:'active' OR status:'trialing')`,
      limit: 1,
    });
    const sub = subs.data[0];
    if (!sub) {
      cfg.license = {
        ...cfg.license,
        tier: "free",
        status: "inactive",
        checked_at: new Date().toISOString(),
      };
    } else {
      const tier: Tier = (sub.metadata?.tier as Tier) || shape.tier || "personal";
      cfg.license = {
        key,
        tier: tier === "free" ? "personal" : tier,
        status: sub.status === "trialing" ? "trialing" : "active",
        checked_at: new Date().toISOString(),
        customer_id: typeof sub.customer === "string" ? sub.customer : sub.customer?.id ?? null,
        subscription_id: sub.id,
      };
    }
  } catch {
    // Network/API failure: keep whatever we last knew, but mark the check time
    // so we retry tomorrow instead of hammering Stripe.
    cfg.license = {
      ...cfg.license,
      status: cfg.license.status === "inactive" && shape.valid ? "active" : cfg.license.status,
      tier: cfg.license.tier === "free" ? shape.tier : cfg.license.tier,
      checked_at: new Date().toISOString(),
    };
  }

  saveConfig(cfg);
  return cfg.license;
}

export class LimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LimitError";
  }
}

/** Called before every billable tool invocation. */
export function enforceQueryLimit(cfg: Config): void {
  const limits = limitsFor(cfg);
  if (limits.queries_per_month === Infinity) return;
  const used = cfg.usage.month === currentMonth() ? cfg.usage.queries : 0;
  if (used >= limits.queries_per_month) {
    throw new LimitError(
      `Free tier limit reached: ${limits.queries_per_month} queries this month. ` +
        `Upgrade at http://localhost:${cfg.settings.port}/#pricing or run \`obsidian-gate license set <key>\`.`,
    );
  }
}

export function enforceVaultLimit(cfg: Config): void {
  const limits = limitsFor(cfg);
  if (cfg.vaults.length >= limits.vaults) {
    throw new LimitError(
      `The ${limits.label} tier allows ${limits.vaults} vault${limits.vaults === 1 ? "" : "s"}. Upgrade to add more.`,
    );
  }
}

export function enforceConnectionLimit(cfg: Config): void {
  const limits = limitsFor(cfg);
  if (cfg.agent_connections.length >= limits.agent_connections) {
    throw new LimitError(
      `The ${limits.label} tier allows ${limits.agent_connections} agent connection${limits.agent_connections === 1 ? "" : "s"}. Upgrade to connect more agents.`,
    );
  }
}

export function licenseSummary(cfg: Config) {
  const tier = tierOf(cfg);
  const limits = LIMITS[tier];
  return {
    tier,
    label: limits.label,
    price: limits.price,
    status: cfg.license.status,
    checked_at: cfg.license.checked_at,
    key_present: Boolean(cfg.license.key),
    limits: {
      queries_per_month:
        limits.queries_per_month === Infinity ? null : limits.queries_per_month,
      vaults: limits.vaults,
      agent_connections:
        limits.agent_connections === Infinity ? null : limits.agent_connections,
    },
    usage: cfg.usage,
  };
}

/* ------------------------------------------------------------------ */
/* Checkout — only used when vendor Stripe credentials are present.    */
/* ------------------------------------------------------------------ */

export async function createCheckoutSession(
  plan: "personal" | "team",
  publicUrl: string,
): Promise<{ url: string }> {
  const stripe = stripeClient();
  if (!stripe) {
    throw new Error(
      "Stripe is not configured on this machine. Set STRIPE_SECRET_KEY, STRIPE_PRICE_PERSONAL and STRIPE_PRICE_TEAM.",
    );
  }
  const price =
    plan === "team"
      ? process.env.STRIPE_PRICE_TEAM
      : process.env.STRIPE_PRICE_PERSONAL;
  if (!price) throw new Error(`No Stripe price configured for the ${plan} plan.`);

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price, quantity: 1 }],
    subscription_data: {
      trial_period_days: Number(process.env.STRIPE_TRIAL_DAYS || 14),
      metadata: { tier: plan },
    },
    success_url: `${publicUrl}/install.html?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${publicUrl}/#pricing`,
  });
  if (!session.url) throw new Error("Stripe did not return a checkout URL.");
  return { url: session.url };
}

export async function createPortalSession(
  cfg: Config,
  publicUrl: string,
): Promise<{ url: string }> {
  const stripe = stripeClient();
  if (!stripe) throw new Error("Stripe is not configured on this machine.");
  if (!cfg.license.customer_id) {
    throw new Error(
      "No Stripe customer on file. Activate a license key first, then manage the subscription from the email receipt.",
    );
  }
  const session = await stripe.billingPortal.sessions.create({
    customer: cfg.license.customer_id,
    return_url: `${publicUrl}/settings.html`,
  });
  return { url: session.url };
}

/* ------------------------------------------------------------------ */
/* License key issuance — the other half of checkout.                  */
/* ------------------------------------------------------------------ */

/**
 * Keys are minted here and stored on the Stripe subscription, which is the
 * only source of truth we have: `validateLicense` finds a subscription by
 * searching `metadata['license_key']`, so a key that was never written back to
 * Stripe would validate today (by shape) and die tomorrow (by search).
 *
 * The `test`/`live` half mirrors the Stripe key that minted it, so a sandbox
 * key can never be mistaken for a paid one when reading logs.
 */
export function generateLicenseKey(tier: "personal" | "team", live: boolean): string {
  return `oa_${live ? "live" : "test"}_${tier}_${crypto.randomBytes(16).toString("hex")}`;
}

export interface ClaimedLicense {
  key: string;
  tier: "personal" | "team";
  status: "active" | "trialing";
  customer_id: string | null;
  subscription_id: string;
}

/**
 * Exchange a completed Checkout Session for the license key it bought.
 *
 * Idempotent: the key lives in the subscription's metadata, so refreshing the
 * success page — or re-claiming from another machine — returns the same key
 * instead of minting a second one.
 */
export async function claimLicenseFromSession(sessionId: string): Promise<ClaimedLicense> {
  const stripe = stripeClient();
  if (!stripe) {
    throw new Error(
      "Stripe is not configured on this machine. Set STRIPE_SECRET_KEY to issue license keys.",
    );
  }
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId.trim())) {
    throw new Error("That does not look like a Stripe Checkout session ID.");
  }

  const session = await stripe.checkout.sessions.retrieve(sessionId.trim(), {
    expand: ["subscription"],
  });

  const sub = session.subscription;
  if (!sub || typeof sub === "string") {
    // Checkout completed but the subscription has not landed yet, or the
    // session was abandoned. Either way there is nothing to hand out.
    throw new Error(
      "No subscription on that checkout session yet. Give Stripe a moment and reload, or contact support with the session ID.",
    );
  }
  if (sub.status !== "active" && sub.status !== "trialing") {
    throw new Error(`That subscription is ${sub.status}, not active.`);
  }

  const existing = sub.metadata?.license_key;
  if (existing) {
    return {
      key: existing,
      tier: (sub.metadata?.tier as "personal" | "team") || "personal",
      status: sub.status === "trialing" ? "trialing" : "active",
      customer_id: typeof sub.customer === "string" ? sub.customer : sub.customer?.id ?? null,
      subscription_id: sub.id,
    };
  }

  // `tier` is set by createCheckoutSession; fall back to the price we sold.
  const tier: "personal" | "team" =
    sub.metadata?.tier === "team" ||
    sub.items.data[0]?.price?.id === process.env.STRIPE_PRICE_TEAM
      ? "team"
      : "personal";
  const key = generateLicenseKey(tier, sub.livemode);

  await stripe.subscriptions.update(sub.id, {
    metadata: { ...(sub.metadata ?? {}), tier, license_key: key },
  });

  return {
    key,
    tier,
    status: sub.status === "trialing" ? "trialing" : "active",
    customer_id: typeof sub.customer === "string" ? sub.customer : sub.customer?.id ?? null,
    subscription_id: sub.id,
  };
}
