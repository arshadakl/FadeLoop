// Browser-facing campaign contract mirrors the existing API without importing Worker globals.
export interface Campaign {
  campaign_id: string;
  name?: string;
  media_id: string;
  keywords: string[];
  match_mode?: "keywords" | "any";
  exclude?: string[];
  public_reply?: { enabled: boolean; texts: string[] };
  check_follow?: boolean;
  ask_email?: boolean;
  reward: { type: "link" | "code" | "text"; value: string };
  copy: {
    opening: string;
    opening_button?: string;
    follow_gate?: string;
    follow_button?: string;
    email_ask?: string;
    delivery: string;
  };
}
export type Page =
  | "automations"
  | "create"
  | "dashboard"
  | "contacts"
  | "archive";
export interface CampaignRow extends Campaign {
  folder_id?: string | null;
  active: boolean;
  archived?: boolean;
  updated_at: number;
}
export interface AutomationFolder { folder_id: string; name: string }
export interface Media {
  id: string;
  caption?: string;
  thumbnail_url?: string;
  media_url?: string;
  media_type?: string;
  like_count?: number;
  comments_count?: number;
}
export interface Status {
  connection_generation: number;
  connected: boolean;
  token_expired?: boolean;
  username?: string;
  profile_picture_url?: string;
  poll_healthy?: boolean;
  poll_age_seconds?: number | null;
  poll_error?: string | null;
  comment_poll_error?: string | null;
}
export interface Session {
  email: string;
  expires_at: number;
}
export interface DashboardData {
  cards: {
    comments: number;
    sends: number;
    clicks: number;
    ctr: number;
    follows: number;
    emails: number;
    delivered: number;
  };
  funnel: { label: string; value: number; pct: number }[];
}
export interface Contact {
  igsid: string;
  username?: string;
  campaign_id: string;
  state: string;
  status_label: string;
  followed: boolean;
  email?: string;
  updated_at: number;
}
