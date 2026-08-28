#!/usr/bin/env node
/**
 * Create the two Obsidian Gate subscription products in Stripe.
 *
 *   STRIPE_SECRET_KEY=sk_test_... node scripts/create-stripe-products.mjs
 *
 * Idempotent: products are looked up by their `og_plan` metadata tag before
 * anything is created, so re-running never leaves duplicate products or prices
 * in the dashboard. Prints the env lines to paste into .env when it finishes.
 *
 * Use a sk_test_ key first and confirm the checkout flow end to end before
 * repeating this against the live account.
 */
import Stripe from "stripe";

// Gate installs from npm and runs on the buyer's own machine, so it is
// downloadable software rather than SaaS. A tax code is not optional: accounts
// with Managed Payments enabled (the default) reject checkout for any product
// that lacks one, so leaving it off ships a store that cannot take money.
const PLANS = [
  {
    plan: "personal",
    name: "Obsidian Gate — Personal",
    amount: 1900,
    env: "STRIPE_PRICE_PERSONAL",
    taxCode: "txcd_10202001", // Downloadable software — non-recreational, personal use
  },
  {
    plan: "team",
    name: "Obsidian Gate — Team",
    amount: 4900,
    env: "STRIPE_PRICE_TEAM",
    taxCode: "txcd_10202003", // Downloadable software — business use
  },
];

const TRIAL_DAYS = Number(process.env.STRIPE_TRIAL_DAYS || 14);

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error("STRIPE_SECRET_KEY is not set. Export your Stripe secret key and re-run.");
  process.exit(1);
}

const stripe = new Stripe(key);
const live = key.startsWith("sk_live_");
console.error(`Using ${live ? "LIVE" : "test"} Stripe account.\n`);

/** Find an existing product for this plan, or create it. */
async function findOrCreateProduct({ plan, name, taxCode }) {
  const found = await stripe.products.search({
    query: `active:'true' AND metadata['og_plan']:'${plan}'`,
    limit: 1,
  });
  if (found.data[0]) {
    console.error(`· product exists  ${name} → ${found.data[0].id}`);
    // Backfill: products created before tax codes were required would other-
    // wise keep failing checkout with no obvious reason.
    if (found.data[0].tax_code !== taxCode) {
      await stripe.products.update(found.data[0].id, { tax_code: taxCode });
      console.error(`  ↳ set tax code  ${taxCode}`);
    }
    return found.data[0];
  }
  const product = await stripe.products.create({
    name,
    description: `Obsidian Gate ${plan} plan — connect your AI agents to your Obsidian vault.`,
    tax_code: taxCode,
    metadata: { og_plan: plan },
  });
  console.error(`+ product created ${name} → ${product.id}`);
  return product;
}

/** Reuse a matching monthly price if one is already attached to the product. */
async function findOrCreatePrice(product, { plan, amount }) {
  const existing = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
  const match = existing.data.find(
    (p) =>
      p.unit_amount === amount &&
      p.currency === "usd" &&
      p.recurring?.interval === "month",
  );
  if (match) {
    console.error(`· price exists    $${(amount / 100).toFixed(0)}/mo → ${match.id}`);
    return match;
  }
  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: amount,
    currency: "usd",
    recurring: { interval: "month", trial_period_days: TRIAL_DAYS },
    metadata: { og_plan: plan },
  });
  console.error(`+ price created   $${(amount / 100).toFixed(0)}/mo → ${price.id}`);
  return price;
}

const env = [];
for (const spec of PLANS) {
  const product = await findOrCreateProduct(spec);
  const price = await findOrCreatePrice(product, spec);
  env.push(`${spec.env}=${price.id}`);
}

console.error(`\nTrial: ${TRIAL_DAYS} days (set on the price and by createCheckoutSession).`);
console.error("\nAdd these to your .env:\n");
// stdout stays clean so `... > .env.stripe` captures only the env lines.
console.log(env.join("\n"));
