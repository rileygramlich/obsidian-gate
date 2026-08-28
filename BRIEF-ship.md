# Obsidian Gate — Ship Checklist

**Project root:** ~/dev/obsidian-gate/

## What's Already Built
- Full MCP server with 9 tools — list_notes, read_note, search_notes, create_note, update_note, get_backlinks, get_tags, get_daily_note, create_link
- Stripe licensing module (src/license.ts) — Free/Personal($19)/Team($49) tiers, Stripe validation, daily cache
- Landing page (public/index.html) with `checkout()` calling POST /api/checkout
- Dashboard, install guide, settings pages
- API key auth with generate/rotate/revoke
- Activity log (JSONL)
- TypeScript compiles clean

## What Needs Doing

### 1. Stripe — Create products + prices — DONE
Created in the Gramlich Software Services **sandbox** (test mode) by
`scripts/create-stripe-products.mjs`: Personal $19/mo and Team $49/mo, both
recurring monthly with a 14-day trial on the price. Re-run the same script with
a `sk_live_` key to mirror them into the live account.

### 2. Wire the Stripe price IDs into license.ts — DONE
Price IDs are in `.env` (gitignored); `POST /api/checkout` builds a real
Checkout Session from them. The missing half is also built: `POST
/api/checkout/claim` trades the returned session for a license key, stores it in
the subscription's `license_key` metadata (idempotent), and activates it locally.

**Still needs a human:** paste a sandbox `sk_test_` secret key into `.env` —
that is the one credential that cannot be generated from here.

### 3. Write basic tests — DONE
`test/` covers health, config, auth, license tiers, vault paths, MCP tools, and
key issuance. 112 tests, all passing.

### 4. Publish — GitHub done, npm pending
Repo is public at github.com/rileygramlich/obsidian-gate; `v1.0.0` is tagged but
has no GitHub Release yet. npm publish still needs `npm login`.

### 5. Final verification
- [x] TypeScript compiles clean
- [x] `npm test` — 112/112
- [ ] End-to-end checkout with a real sandbox key (blocked on the key above)

## What NOT to Do
- ❌ Don't touch the MCP tools (they work)
- ❌ Don't modify the landing page design
- ❌ Don't add features — ship what's built