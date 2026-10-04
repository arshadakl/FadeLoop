import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import {
  buildCampaignFromDraft,
  defaultDraft,
  draftFromCampaign,
  validateDraft,
} from "../frontend/src/lib/campaign";
import type { CampaignRow } from "../frontend/src/types";

// Compare the migration to the actual pre-migration editor, including its uncommitted edits.
const original = readFileSync("public/app.js", "utf8");
function legacy(
  name: string,
  next: string,
  expression: string,
  globals: object = {},
) {
  const source = original.slice(
    original.indexOf(`function ${name}(`),
    original.indexOf(next, original.indexOf(`function ${name}(`)),
  );
  return JSON.parse(
    JSON.stringify(runInNewContext(`${source}\n${expression}`, globals)),
  );
}
describe("React campaign editor compatibility", () => {
  it("preserves every initial draft value", () => {
    const { match_mode, folder_id, ...legacyDraft } = defaultDraft();
    expect(match_mode).toBe("keywords");
    expect(folder_id).toBeNull();
    expect(legacyDraft).toEqual(
      legacy("defaultDraft", "async function renderCreate(", "defaultDraft()", {
        store: { media: [] },
      }),
    );
  });
  it("loads saved campaigns without losing existing reward types, copy, and options", () => {
    const c: CampaignRow = {
      campaign_id: "saved",
      name: "Saved automation",
      media_id: "post",
      active: true,
      updated_at: 10,
      keywords: ["LINK", "GUIDE"],
      exclude: ["fake"],
      public_reply: { enabled: true, texts: ["First", "Second"] },
      check_follow: true,
      ask_email: true,
      reward: { type: "code", value: "HELLO" },
      copy: { opening: "Custom opening", delivery: "Your code: {reward}" },
    };
    const source = original.slice(
      original.indexOf("function defaultDraft("),
      original.indexOf("async function renderCreate("),
    );
    const previous = runInNewContext(`${source}\ndraftFromCampaign(c)`, {
      c,
      store: { media: [{ id: "post", thumbnail_url: "thumb" }] },
    });
    const { match_mode, folder_id, ...legacyDraft } = draftFromCampaign(c, [{ id: "post", thumbnail_url: "thumb" }]);
    expect(match_mode).toBe("keywords");
    expect(folder_id).toBeNull();
    expect(legacyDraft).toEqual(JSON.parse(JSON.stringify(previous)));
    const converted = draftFromCampaign(c);
    converted.public_reply.texts.push("Edit");
    expect(c.public_reply!.texts).toEqual(["First", "Second"]);
  });
  it("preserves the save wire payload and excludes editor-only fields", () => {
    const draft = {
      ...defaultDraft(),
      campaign_id: "stable",
      media_id: "post",
      active: true,
      check_follow: true,
      ask_email: true,
    };
    draft.reward = { type: "text", value: "A reward" };
    const previous = legacy(
      "buildCampaignFromDraft",
      "function validateDraft(",
      "buildCampaignFromDraft()",
      { store: { draft }, slug: () => "unused" },
    );
    expect(buildCampaignFromDraft(draft)).toEqual(previous);
    expect(buildCampaignFromDraft(draft)).not.toHaveProperty("opening_enabled");
    expect(buildCampaignFromDraft(draft)).not.toHaveProperty("active");
  });
  it("preserves validation order and requirements", () => {
    const draft = defaultDraft();
    for (const change of [
      {},
      { media_id: "post", keywords: [] },
      { keywords: ["GUIDE"] },
      {
        reward: { type: "link" as const, value: "https://example.com" },
        opening_enabled: false,
      },
      { opening_enabled: true },
    ]) {
      Object.assign(draft, change);
      expect(validateDraft(draft)).toEqual(
        legacy(
          "validateDraft",
          "async function saveCampaign(",
          "validateDraft(draft)",
          { draft },
        ),
      );
    }
  });
});
