import { beforeEach, describe, expect, it } from 'vitest';
import { Engine } from '../src/engine/engine';
import { SendQueue } from '../src/queue/queue';
import { upsertCampaign } from '../src/db';
import { pollComments } from '../src/poller/commentPoll';
import { handleApi } from '../src/routes/api';
import type { Campaign, Env, NormalizedComment } from '../src/types';
import { makeTestDb } from './helpers/fakeD1';
import { FakeClient } from './helpers/fakeClient';

let db: D1Database;
let client: FakeClient;
let engine: Engine;
let runtime: any;

function createCampaign(id: string, mediaId: string, keyword = 'LINK'): Campaign {
  return {
    campaign_id: id,
    media_id: mediaId,
    keywords: [keyword],
    exclude: [],
    reward: { type: 'link', value: 'https://example.com' },
    copy: {
      opening: `Hello from ${id}`,
      opening_button: 'Tap',
      follow_gate: 'Follow',
      follow_button: '✅ I followed',
      email_ask: 'Email?',
      delivery: 'Here {reward}',
    },
  };
}

beforeEach(() => {
  db = makeTestDb();
  client = new FakeClient();
  engine = new Engine(db, client as any, new SendQueue({ minIntervalMs: 0, maxRetries: 0 }), { generation: 1 });
  runtime = {
    db,
    client: client.asClient(),
    queue: new SendQueue(),
    engine,
    auth: { connection_generation: 1 },
    igUserId: 'my_ig_id',
  };
});

describe('Multi-automation throughput and stability', () => {
  it('polls multiple active media items in a single tick up to batch limit', async () => {
    // 5 active automations across 5 different posts
    for (let i = 1; i <= 5; i++) {
      await upsertCampaign(db, createCampaign(`c${i}`, `media_${i}`), true);
    }

    (client as any).getCommentsPage = async (mediaId: string) => {
      return { data: [], cursor: null };
    };

    await pollComments(runtime, db);

    // Verify all 5 media checkpoints were created and attempted
    const checkpoints = await db.prepare(
      "SELECT key, next_at FROM polling_checkpoints WHERE substr(key, 1, 9) = 'comments:'"
    ).all<{ key: string; next_at: number }>();

    expect(checkpoints.results).toHaveLength(5);
    const keys = checkpoints.results.map((c) => c.key).sort();
    expect(keys).toEqual([
      'comments:media_1',
      'comments:media_2',
      'comments:media_3',
      'comments:media_4',
      'comments:media_5',
    ]);

    // Since they had zero comments, all 5 adaptively backed off to 3m (~180s)
    const nowMs = Date.now();
    for (const cp of checkpoints.results) {
      expect(cp.next_at).toBeGreaterThanOrEqual(nowMs + 100_000);
    }
  });

  it('posts with new comments stay on the fast 60s schedule', async () => {
    await upsertCampaign(db, createCampaign('c1', 'active_post'), true);

    (client as any).getCommentsPage = async (mediaId: string) => {
      return {
        data: [
          {
            id: 'comm_1',
            text: 'LINK',
            timestamp: new Date().toISOString(),
            from: { id: 'user_1', username: 'user_1' },
          },
        ],
        cursor: null,
      };
    };

    await pollComments(runtime, db);

    const cp = await db.prepare(
      "SELECT next_at FROM polling_checkpoints WHERE key = 'comments:active_post'"
    ).first<{ next_at: number }>();

    expect(cp).not.toBeNull();
    const nowMs = Date.now();
    // Active post stays on fast 60s schedule (<= now + 65s)
    expect(cp!.next_at).toBeLessThanOrEqual(nowMs + 65_000);
    expect(cp!.next_at).toBeGreaterThan(nowMs);
  });

  it('batch campaign stats aggregates runs and ctr across all automations in one query', async () => {
    await upsertCampaign(db, createCampaign('camp_a', 'post_a'), true);
    await upsertCampaign(db, createCampaign('camp_b', 'post_b'), true);

    const nowSec = Math.floor(Date.now() / 1000);
    // Simulate events for camp_a: 10 sends, 5 clicks (50% CTR)
    const eventsA = [
      ...Array(10).fill({ camp: 'camp_a', type: 'opening_sent' }),
      ...Array(5).fill({ camp: 'camp_a', type: 'button_clicked' }),
    ];
    // Simulate events for camp_b: 20 sends, 16 clicks (80% CTR)
    const eventsB = [
      ...Array(20).fill({ camp: 'camp_b', type: 'opening_sent' }),
      ...Array(16).fill({ camp: 'camp_b', type: 'button_clicked' }),
    ];

    for (const e of [...eventsA, ...eventsB]) {
      await db.prepare('INSERT INTO events(campaign_id, igsid, type, created_at) VALUES(?, ?, ?, ?)')
        .bind(e.camp, 'u_test', e.type, nowSec)
        .run();
    }

    const env: Env = { DB: db } as any;
    const req = new Request('https://test.fadeloop.com/api/campaigns/stats');
    const res = await handleApi(env, req, new URL(req.url));
    expect(res.status).toBe(200);

    const body = await res.json() as { stats: Record<string, { runs: number; ctr: number }> };
    expect(body.stats).toBeDefined();
    expect(body.stats['camp_a']).toEqual({ runs: 10, ctr: 50 });
    expect(body.stats['camp_b']).toEqual({ runs: 20, ctr: 80 });
  });

  it('multiple queued comments dispatch across automations without 60s hold penalty', async () => {
    await upsertCampaign(db, createCampaign('c1', 'm1'), true);
    await upsertCampaign(db, createCampaign('c2', 'm2'), true);
    await upsertCampaign(db, createCampaign('c3', 'm3'), true);

    // Ingest 3 comments across 3 separate automations
    const comments: NormalizedComment[] = [
      { kind: 'comment', comment_id: 'cm1', igsid: 'u1', username: 'u1', text: 'LINK', media_id: 'm1', timestamp: Math.floor(Date.now() / 1000) },
      { kind: 'comment', comment_id: 'cm2', igsid: 'u2', username: 'u2', text: 'LINK', media_id: 'm2', timestamp: Math.floor(Date.now() / 1000) },
      { kind: 'comment', comment_id: 'cm3', igsid: 'u3', username: 'u3', text: 'LINK', media_id: 'm3', timestamp: Math.floor(Date.now() / 1000) },
    ];

    await engine.ingest(comments, 'test');
    await engine.drain();

    // All 3 comments planned and all 3 jobs dispatched without being penalized with a 60-second hold
    expect(client.calls.privateReply).toHaveLength(3);
    const held = await db.prepare("SELECT COUNT(*) n FROM outbound_jobs WHERE status = 'held'").first<{ n: number }>();
    expect(held?.n).toBe(0);
  });
});
