# Frontend development and release

FadeLoop uses React, TypeScript, Vite, Tailwind CSS, and locally maintained shadcn/ui components. The frontend edits existing campaign configuration through the existing Worker APIs; it does not run automation logic or connect directly to D1.

## Local development

Run `npm install`, apply local migrations, and provision a local owner using `npm run owner:create -- --local`. Local and production owner accounts are separate.

Start `npm run dev` for Wrangler on port 8787. This builds the frontend first and serves `dist/ui`. In another terminal, run `npm run dev:ui` and open Vite's printed URL for hot reload. Vite proxies `/api`, `/session`, and `/auth` to Wrangler. Instagram OAuth still requires a callback URI registered with Meta for the environment being tested.

Edit React components under `frontend/src`; edit presentation tokens in `frontend/src/styles.css`. shadcn/ui component sources are under `frontend/src/components/ui`, with configuration in `frontend/components.json`. Inter font assets are bundled locally; Outfit Latin 700 is bundled only for the FadeLoop wordmark, with its license in `frontend/public/Outfit-LICENSE.txt`. The original `public/` files are retained as a compatibility reference, including existing uncommitted edits; Wrangler no longer serves them.

The shared brand asset is `frontend/public/logo.svg`. Login, sidebar, mobile header, and legal navigation reference that asset. App and legal entries share SVG and PNG favicons and an Apple touch icon. To regenerate the committed PNGs from the SVG, run `node scripts/build-brand-icons.mjs` with Playwright Chromium installed. Production builds serve these assets locally.

Legal pages are static Vite HTML entries. Preserve their text when editing presentation. Their public URLs remain `/privacy`, `/terms`, and `/data-deletion`. The early theme script retains the existing `fadeloop_theme` preference and applies System, Light, or Dark before rendering.

## Verification

Run `npm run typecheck`, `npm test`, `npm run test:ui`, and `npm run test:worker-auth`. Browser tests use disposable in-memory D1 and fixture credentials, never the real owner's database. Screenshots and traces are written to gitignored `test-results/`.

Browser coverage includes both themes at 320, 375, 390, 768, and 1440px, folder menus and history, direct links, missing folders, unsaved-draft cancellation, save/activation, public replies, follow/email options, preview modes, archive/restore/delete, contact export, session expiration, recovery from request failures, obsolete filter requests, older campaign configuration, and accessibility checks on mobile and desktop.

## Preview and rollout

`npm run deploy:dry-run` rebuilds authentication and frontend assets and checks the Worker bundle. For a preview, build first and use `npx wrangler versions upload --preview-alias ui-redesign`. This uploads a version without changing production traffic. Verify login, connected/disconnected states, existing-data access, and the public legal pages on the printed preview URL.

Record the active version from `npx wrangler deployments list`, then release the tested version with `npx wrangler versions deploy <version-id>@100% --yes`. If verification fails after rollout, redeploy the recorded previous version with the same command. A frontend-only release does not require a D1 migration. Future backend changes must continue to follow the migration-before-deployment procedure in the README.

The folders/Any comment/account-settings release includes backend changes: apply migration 0007 before preview deployment. Its password-change hashing currently exceeds the Free-plan CPU budget in deployed measurements, so hold production rollout until that limitation is resolved; see [authentication](authentication.md). Do not treat the earlier frontend-only deployment instructions as approval to bypass this release gate.

Keep cookies, credentials, private deployment notes, and real customer-data screenshots out of source control. The one-off release record is stored locally under gitignored `.wrangler/`.
