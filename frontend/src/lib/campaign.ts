import type { Campaign, CampaignRow, Media } from "../types";
export interface Draft {
  campaign_id: string;
  name: string;
  media_id: string;
  media_thumb: string;
  keywords: string[];
  match_mode: "keywords" | "any";
  folder_id: string | null;
  exclude: string[];
  public_reply: { enabled: boolean; texts: string[] };
  opening_enabled: boolean;
  check_follow: boolean;
  ask_email: boolean;
  reward: Campaign["reward"];
  copy: Campaign["copy"];
  active: boolean;
}
export function defaultDraft(): Draft {
  return {
    campaign_id: "",
    name: "My automation",
    media_id: "",
    media_thumb: "",
    keywords: ["Link"],
    match_mode: "keywords",
    folder_id: null,
    exclude: [],
    public_reply: {
      enabled: false,
      texts: ["Sent you a DM! 📩", "Check your DMs 👀"],
    },
    opening_enabled: true,
    check_follow: false,
    ask_email: false,
    reward: { type: "link", value: "" },
    copy: {
      opening: "Hey! Tap below to grab the link 👇",
      opening_button: "Send it to me",
      follow_gate:
        "Make sure you're following so you don't miss the next one 🙌 Not following yet? Follow, then tap below.",
      follow_button: "✅ I followed",
      email_ask: "Want it in your inbox too? Tap your email or reply with it.",
      delivery: "Here you go 🎉 {reward}",
    },
    active: false,
  };
}
export function draftFromCampaign(c: CampaignRow, media: Media[] = []): Draft {
  return {
    campaign_id: c.campaign_id,
    name: c.name || c.campaign_id,
    media_id: c.media_id,
    media_thumb: media.find((m) => m.id === c.media_id)?.thumbnail_url || "",
    keywords: [...(c.keywords || [])],
    match_mode: c.match_mode || "keywords",
    folder_id: c.folder_id || null,
    exclude: [...(c.exclude || [])],
    public_reply: structuredClone(
      c.public_reply || { enabled: false, texts: ["Sent you a DM! 📩"] },
    ),
    opening_enabled: true,
    check_follow: !!c.check_follow,
    ask_email: !!c.ask_email,
    reward: structuredClone(c.reward || { type: "link", value: "" }),
    copy: { ...defaultDraft().copy, ...c.copy },
    active: !!c.active,
  };
}
export function buildCampaignFromDraft(d: Draft): Campaign {
  const slug =
    String(d.name || "campaign")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "campaign";
  return {
    campaign_id:
      d.campaign_id || `${slug}-${Math.random().toString(36).slice(2, 8)}`,
    name: d.name,
    media_id: d.media_id,
    keywords: d.keywords,
    ...(d.match_mode === "any" ? { match_mode: "any" as const } : {}),
    exclude: d.exclude,
    public_reply: {
      enabled: d.public_reply.enabled,
      texts: d.public_reply.texts,
    },
    check_follow: d.check_follow,
    ask_email: d.ask_email,
    reward: d.reward,
    copy: d.copy,
  };
}
export function validateDraft(d: Draft) {
  if (!d.media_id) return "Select a post or reel in section 1.";
  if (d.match_mode !== "any" && !d.keywords.length) return "Add at least one keyword in section 2.";
  if (!d.reward.value) return "Add your link or reward in section 4.";
  if (!d.opening_enabled)
    return "Turn on the opening DM — it’s required to start the funnel.";
  return null;
}
