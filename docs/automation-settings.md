# Folders and Any comment

Folders organize automations without changing their behavior. The Automations root shows folder tiles followed by unfiled automations. Open a tile to browse its automations; use Back or the Automations breadcrumb to return. Create through **New folder**; right-click a tile or use its three-dot menu to open, rename, or delete it. Shift+F10 opens its keyboard menu. Folders are single-level.

Search at root matches folder names and unfiled automations; inside a folder it matches automation names. Status filters apply to automations. Changing folders clears search and selection, while opening an automation and returning preserves the current search and status. Locations use `#automations` and `#automations/folder/<id>` and support direct links and browser history. Unsaved drafts still require confirmation before leaving.

Select automations and use **Move selected** to assign a folder or move them to **Unfiled**. Folder deletion retains all automations; archive and restore retain membership. Each automation has at most one folder. Bulk movement supports up to 100 automations per request. Folder counts come from the existing campaign list without additional requests.

Use **View as grid** / **View as list** to switch automation layouts in the current location. Both layouts retain search, status filters, selection, bulk actions, statistics, and keyboard editing. Grid uses three columns on wide desktops, two on smaller desktops/tablets, and one on phones. The browser remembers the chosen layout locally; switching views does not add API requests.

In Create, keep selecting a specific post or reel. **Comment matching → Any comment** accepts nonempty text and emoji, while excluded words retain the existing whole-word, case-insensitive rule. Switching modes preserves entered keywords. New Any comment activations accept only comments timestamped strictly after activation; comments with missing/invalid timestamps are ignored. Reactivation and switching an active campaign into Any comment start a new boundary. Ordinary saves do not. Restoring an active archived Any comment campaign also starts a new boundary to avoid sending to comments made while archived.

Existing keyword campaigns keep their existing rules. Any comment retains one opening per person per campaign and the existing retry/queue behavior. It does not scan additional posts or add cron runs. More eligible comments can increase sending and D1 writes.

Campaign APIs accept optional `match_mode: "keywords" | "any"`; missing mode means keywords. `activated_at` is server-owned and cannot be supplied through configuration. Campaign save accepts optional top-level `folder_id` (`null` for Unfiled); campaign list returns membership. Folder endpoints use owner sessions and same-origin mutation checks:

- `GET /api/folders`, `POST /api/folders` with `{ name }`
- `POST /api/folders/rename` with `{ folder_id, name }`
- `POST /api/folders/delete` with `{ folder_id }`
- `POST /api/folders/move` with `{ folder_id, campaign_ids }`

Apply migration `0007_folders_any_comment.sql` before deploying this version. It adds separate organization and activation tables; existing configurations, conversations, Instagram credentials, and analytics are preserved.

Run `node scripts/benchmark-any-comment.mjs` for a disposable workerd/D1 workload comparison. It uses fixture sends, 100 unique commenters, and a second pass of identical comments. Results measure D1 rows and local wall time, not deployed CPU or account capacity. Real delivery volume remains subject to Meta sending limits and Cloudflare usage limits. See [authentication](authentication.md) for the measured password-hashing release blocker before deploying this combined release.

The 2026-10-04 fixture measured 310 row writes / 10 sends in keyword mode versus 1,300 row writes / 100 sends in Any comment mode. Repeating the same comments wrote no rows and sent no messages. These counts include index writes and depend on enabled actions. The synthetic 100-comment batch performed 251 and 702 D1 queries respectively; it is **not** a valid single-invocation Free-plan capacity test (Free permits 50 D1 queries per invocation). High-volume polling or webhook batches need further budgeting work before claiming Free-plan support. Existing sending caps do not by themselves bound query count.
