import { describe, expect, it } from "vitest";
import { claimPollSlot } from "../src/db";
import { makeTestDb } from "./helpers/fakeD1";

describe("claimPollSlot (regression: overlapping poll invocations must not both win)", () => {
  it("the first claim within an interval succeeds", async () => {
    const db = makeTestDb();
    expect(await claimPollSlot(db, 90)).toBe(true);
  });

  it("a second claim right after the first, within the interval, is rejected", async () => {
    const db = makeTestDb();
    expect(await claimPollSlot(db, 90)).toBe(true);
    expect(await claimPollSlot(db, 90)).toBe(false); // not due yet
  });

  it("two 'simultaneous' claims (racing before either has written) — only one wins", async () => {
    const db = makeTestDb();
    // Simulates two overlapping invocations (e.g. an overlapping cron tick, or /admin/poll
    // racing the cron) both attempting to claim the slot back-to-back with no gap between them.
    const results = await Promise.all([claimPollSlot(db, 90), claimPollSlot(db, 90)]);
    const wins = results.filter(Boolean).length;
    expect(wins).toBe(1); // exactly one invocation may proceed to actually poll
  });
});
