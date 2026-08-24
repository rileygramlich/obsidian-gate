# Obsidian Gate — Ship Checklist

**Project root:** ~/workspace/dev/obsidian-gate/

## What's Already Built
- Full MCP server with 9 tools — list_notes, read_note, search_notes, create_note, update_note, get_backlinks, get_tags, get_daily_note, create_link
- Stripe licensing module (src/license.ts) — Free/Personal($19)/Team($49) tiers, Stripe validation, daily cache
- Landing page (public/index.html) with `checkout()` calling POST /api/checkout
- Dashboard, install guide, settings pages
- API key auth with generate/rotate/revoke
- Activity log (JSONL)
- TypeScript compiles clean

## What Needs Doing

### 1. Stripe — Create products + prices
The landing page and license module reference Personal ($19/mo) and Team ($49/mo). Need real Stripe product/price IDs created so checkout works. Use the Stripe CLI or API to create:

- Product: "Obsidian Gate — Personal" — $19/month recurring
- Product: "Obsidian Gate — Team" — $49/month recurring
- Both with 14-day trial

### 2. Wire the Stripe price IDs into license.ts
The license module needs the actual price IDs. Read `.env.example` to see the env vars. Make sure `POST /api/checkout` creates real Stripe Checkout Sessions.

### 3. Write basic tests
Create `test/` directory with at minimum:
- Health check test
- Config loading test
- License tier enforcement test
- Vault path resolution test

### 4. Publish to npm
- Bump version if needed
- `npm publish` — needs auth (user has npm account)
- Tag v1.0.0 release on GitHub

### 5. Final verification
- Server starts: `npx obsidian-gate` → dashboard on :3100
- MCP mode: `npx obsidian-gate --mcp` → tools/list returns 9 tools
- Doctor: `npx obsidian-gate doctor` → all checks pass
- Checkout: landing page POST /api/checkout creates a real Stripe session URL

## Build Order
1. Create Stripe products with CLI
2. Wire price IDs into license.ts
3. Write tests in test/
4. npm publish
5. Verify everything

## What NOT to Do
- ❌ Don't touch the MCP tools (they work)
- ❌ Don't modify the landing page design
- ❌ Don't add features — ship what's built