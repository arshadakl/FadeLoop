import { describe, expect, it, vi } from "vitest";
import { makeTestDbWithHandle, applyMigration } from "./helpers/fakeD1";
import { getActiveCampaigns, getAllCampaigns, setCampaignActive, setCampaignArchived, upsertCampaign } from "../src/db";
import { validateCampaign } from "../src/config";
import { Engine } from "../src/engine/engine";
import { SendQueue } from "../src/queue/queue";
import { FakeClient } from "./helpers/fakeClient";
import { folders } from "../src/routes/folders";
import type { Campaign, Env, NormalizedComment } from "../src/types";
import type { Runtime } from "../src/runtime";
import { pollComments } from "../src/poller/commentPoll";

const campaign = (over: Partial<Campaign> = {}): Campaign => ({ campaign_id: "c1", media_id: "m1", keywords: ["LINK"], reward: { type: "link", value: "https://example.com" }, copy: { opening: "Tap", delivery: "Here {reward}" }, ...over });
const event = (over: Partial<NormalizedComment> = {}): NormalizedComment => ({ kind: "comment", comment_id: "comment1", igsid: "u1", text: "👋", media_id: "m1", timestamp: Math.floor(Date.now() / 1000) + 1, ...over });

describe("Any comment eligibility", () => {
  it("polling skips missing/invalid/old timestamps and deduplicates new comments", async () => {
    const { db } = makeTestDbWithHandle();
    await upsertCampaign(db, campaign({ match_mode: "any", keywords: [] }), true);
    const client = new FakeClient();
    const engine = new Engine(db, client as never, new SendQueue({ minIntervalMs: 0, maxRetries: 0 }));
    const runtime = { engine, client: Object.assign(client, { getComments: async () => [
      { id: "missing", text: "👋", from: { id: "a" } },
      { id: "bad", text: "👋", from: { id: "b" }, timestamp: "invalid" },
      { id: "old", text: "👋", from: { id: "c" }, timestamp: new Date(Date.now() - 60_000).toISOString() },
      { id: "new", text: "👋", from: { id: "d" }, timestamp: new Date(Date.now() + 1000).toISOString() },
    ] }) } as unknown as Runtime;
    await pollComments(runtime, db);
    await pollComments(runtime, db);
    expect(client.calls.privateReply).toHaveLength(1);
  });
  it("keeps legacy validation and rejects unsupported modes", () => {
    expect(validateCampaign(campaign()).match_mode).toBeUndefined();
    expect(() => validateCampaign(campaign({ keywords: [] }))).toThrow();
    expect(validateCampaign(campaign({ match_mode: "any", keywords: [] })).match_mode).toBe("any");
    expect(() => validateCampaign({ ...campaign(), match_mode: "all" })).toThrow();
    expect(() => validateCampaign(campaign({ media_id: "", match_mode: "any" }))).toThrow();
  });
  it("ignores caller timestamps, preserves boundaries on save, resets on mode switches/reactivation/restore", async () => {
    const { db } = makeTestDbWithHandle();
    const clock = vi.spyOn(Date, "now");
    try {
      clock.mockReturnValue(100_000);
      await upsertCampaign(db, campaign({ match_mode: "any", activated_at: 1 }), true);
      expect((await getActiveCampaigns(db))[0]?.activated_at).toBe(100);
      clock.mockReturnValue(200_000);
      await upsertCampaign(db, campaign({ match_mode: "any" }), true);
      await setCampaignActive(db, "c1", true);
      expect((await getActiveCampaigns(db))[0]?.activated_at).toBe(100);
      await setCampaignActive(db, "c1", false);
      await setCampaignActive(db, "c1", true);
      expect((await getActiveCampaigns(db))[0]?.activated_at).toBe(200);
      clock.mockReturnValue(300_000);
      await upsertCampaign(db, campaign(), true);
      await upsertCampaign(db, campaign({ match_mode: "any" }), true);
      expect((await getActiveCampaigns(db))[0]?.activated_at).toBe(300);
      await setCampaignArchived(db, "c1", true);
      clock.mockReturnValue(400_000);
      await setCampaignArchived(db, "c1", false);
      expect((await getActiveCampaigns(db))[0]?.activated_at).toBe(400);
    } finally { clock.mockRestore(); }
  });
  it("accepts emoji and text, excludes whole words, and skips old/undated/empty/wrong-media comments", async () => {
    const { db } = makeTestDbWithHandle();
    await upsertCampaign(db, campaign({ match_mode: "any", keywords: [], exclude: ["fake"] }), true);
    const client = new FakeClient();
    const engine = new Engine(db, client as never, new SendQueue({ minIntervalMs: 0, maxRetries: 0 }));
    const boundary = (await getActiveCampaigns(db))[0]!.activated_at!;
    for (const [index, changes] of [
      { timestamp: boundary }, { timestamp: 0 }, { timestamp: NaN }, { text: " " }, { text: "FAKE 👋" }, { media_id: "other" },
      { text: "👋" }, { text: "hello" },
    ].entries()) await engine.handleComment(event({ ...changes, comment_id: `cm${index}`, igsid: `u${index}` }));
    expect(client.calls.privateReply).toHaveLength(2);
    await engine.handleComment(event({ comment_id: "cm6", igsid: "u6" }));
    await engine.handleComment(event({ comment_id: "again", igsid: "u6" }));
    expect(client.calls.privateReply).toHaveLength(2);
    await engine.handleComment(event({ comment_id: "cm1", igsid: "u1", timestamp: boundary + 1 }));
    expect(client.calls.privateReply).toHaveLength(3);
  });
});

describe("folder organization and additive migration", () => {
  it("moves 100 automations in bounded queries and rejects larger selections", async () => {
    const { db, raw } = makeTestDbWithHandle();
    raw.exec("INSERT INTO automation_folders VALUES ('bulk', 'Bulk', 1)");
    const ids = Array.from({ length: 100 }, (_, index) => `bulk${index}`);
    for (const id of ids) await upsertCampaign(db, campaign({ campaign_id: id }), false);
    const move = (campaign_ids: string[], folder_id: string | null) => folders({ DB: db } as Env, new Request("https://test/api/folders/move", { method: "POST", body: JSON.stringify({ campaign_ids, folder_id }) }), "/api/folders/move");
    expect((await move([...ids, "too-many"], "bulk")).status).toBe(400);
    expect((await move(ids, "bulk")).status).toBe(200);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM campaign_folders").get()).toMatchObject({ n: 100 });
    expect((await move(ids, null)).status).toBe(200);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM campaign_folders").get()).toMatchObject({ n: 0 });
  });
  it("preserves existing configuration and authentication rows", async () => {
    const { db, raw } = makeTestDbWithHandle("0006");
    await upsertCampaign(db, campaign(), true);
    raw.exec("INSERT INTO auth (id, access_token, expires_at) VALUES (1, 'fixture', 123)");
    raw.exec("INSERT INTO conversations (igsid, campaign_id, state, created_at, updated_at) VALUES ('person', 'c1', 'AWAITING_TAP', 10, 20)");
    raw.exec("INSERT INTO events (campaign_id, igsid, type, created_at) VALUES ('c1', 'person', 'opening_sent', 20)");
    raw.exec("INSERT INTO owner_accounts (id, email, password_hash, updated_at) VALUES (1, 'fixture@example.com', 'hash', 20)");
    const tables = ["campaigns", "auth", "conversations", "events", "owner_accounts"];
    const before = tables.map(table => raw.prepare(`SELECT * FROM ${table}`).all());
    applyMigration(raw, "0007_folders_any_comment.sql");
    tables.forEach((table, index) => expect(raw.prepare(`SELECT * FROM ${table}`).all()).toEqual(before[index]));
    expect(raw.prepare("SELECT access_token FROM auth").get()).toMatchObject({ access_token: "fixture" });
  });
  it("creates, renames, moves, filters via membership, retains archive membership, and deletes only folders", async () => {
    const { db } = makeTestDbWithHandle();
    await upsertCampaign(db, campaign(), true);
    const env = { DB: db } as Env;
    const post = (path: string, body: object) => folders(env, new Request("https://test" + path, { method: "POST", body: JSON.stringify(body) }), path);
    const created = await post("/api/folders", { name: "Launch" });
    const id = (await created.json() as { folder_id: string }).folder_id;
    expect((await post("/api/folders", { name: "launch" })).status).toBe(409);
    expect((await post("/api/folders/rename", { folder_id: id, name: "Guides" })).status).toBe(200);
    expect((await post("/api/folders/move", { folder_id: id, campaign_ids: ["c1", "missing"] })).status).toBe(404);
    expect((await getAllCampaigns(db))[0]?.folder_id).toBeNull();
    expect((await post("/api/folders/move", { folder_id: id, campaign_ids: ["c1"] })).status).toBe(200);
    await setCampaignArchived(db, "c1", true);
    expect((await getAllCampaigns(db, { archived: true }))[0]?.folder_id).toBe(id);
    await setCampaignArchived(db, "c1", false);
    expect((await post("/api/folders/delete", { folder_id: id })).status).toBe(200);
    expect((await getAllCampaigns(db))[0]).toMatchObject({ folder_id: null, active: true });
    expect((await getActiveCampaigns(db))[0]?.campaign_id).toBe("c1");
  });
});
