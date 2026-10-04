import { useState } from "react";
import {
  BatteryFull,
  Heart,
  MessageCircle,
  Send,
  Signal,
  Wifi,
} from "lucide-react";
import type { Media, Status } from "./types";
import type { Draft } from "./lib/campaign";
export function PhonePreview({
  draft: d,
  media,
  status,
}: {
  draft: Draft;
  media: Media[];
  status: Status;
}) {
  const [tab, setTab] = useState("dm");
  const [expanded, setExpanded] = useState(false);
  const post = media.find((m) => m.id === d.media_id) || media[0];
  const thumb = d.media_thumb || post?.thumbnail_url || post?.media_url;
  const keyword = d.match_mode === "any" ? "👋" : d.keywords[0] || "Link";
  const username = status.username || "yourbrand";
  const caption =
    post?.caption ||
    `New drop is live 🔥 comment "${keyword}" and I'll send it.`;
  const captionLong = caption.length > 70;
  const captionShown =
    expanded || !captionLong ? caption : caption.slice(0, 70) + "…";
  const delivery = (d.copy.delivery || "").replace(
    /\{reward\}/g,
    d.reward.value || "your link",
  );
  return (
    <div className="phone" aria-label="Instagram preview">
      <div className="phone-status">
        <strong>9:41</strong>
        <span>
          <Signal size={17} />
          <Wifi size={17} />
          <BatteryFull size={24} />
        </span>
      </div>
      <div className="phone-tabs" role="tablist" aria-label="Preview mode">
        {["post", "comments", "dm"].map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            aria-controls="preview-panel"
            onClick={() => {
              setTab(value);
              setExpanded(false);
            }}
          >
            {value === "dm" ? "DM" : value[0].toUpperCase() + value.slice(1)}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="preview-panel" aria-label={`${tab} preview`}>
        {tab === "dm" && (
          <div className="dm-preview">
            {d.opening_enabled ? (
              <>
                <Bubble>{d.copy.opening}</Bubble>
                <div className="dm-button">
                  {d.copy.opening_button || "Continue"}
                </div>
                <Bubble outgoing>{d.copy.opening_button || "Continue"}</Bubble>
                <div className="dm-note">
                  tap moves the chat out of Requests →
                </div>
              </>
            ) : (
              <div className="dm-note">
                Opening DM is off — the funnel won’t start.
              </div>
            )}
            {d.check_follow && (
              <>
                <Bubble>{d.copy.follow_gate}</Bubble>
                <div className="dm-button">
                  {d.copy.follow_button || "✅ I followed"}
                </div>
                <Bubble outgoing>
                  {d.copy.follow_button || "✅ I followed"}
                </Bubble>
              </>
            )}
            {d.ask_email && (
              <>
                <Bubble>{d.copy.email_ask}</Bubble>
                <div className="email-chip">your@email.com</div>
                <Bubble outgoing>your@email.com</Bubble>
              </>
            )}
            <Bubble>{delivery}</Bubble>
          </div>
        )}
        {tab === "post" && (
          <div className="post-preview">
            <div className="preview-profile">
              <Avatar url={status.profile_picture_url} username={username} />
              <strong>{username}</strong>
            </div>
            {thumb ? (
              <img className="post-image" src={thumb} alt="Selected post" />
            ) : (
              <div className="post-image placeholder" />
            )}
            <div className="post-actions">
              <Heart />
              <MessageCircle />
              <Send />
            </div>
            <p className="post-count">
              {(post?.like_count ?? 128).toLocaleString()} likes ·{" "}
              {(post?.comments_count ?? 0) + (d.public_reply.enabled ? 1 : 0)}{" "}
              comments
            </p>
            <p className="post-caption">
              <strong>{username}</strong> {captionShown}
              {captionLong && (
                <button onClick={() => setExpanded((v) => !v)}>
                  {expanded ? "less" : "more"}
                </button>
              )}
            </p>
          </div>
        )}
        {tab === "comments" && (
          <div className="comments-preview">
            {thumb && (
              <img className="comments-image" src={thumb} alt="Selected post" />
            )}
            <h3>Comments</h3>
            <div className="preview-comment">
              <Avatar username="follower" />
              <div>
                <strong>follower</strong>
                <p>{keyword}!</p>
                <small>2m · Reply</small>
              </div>
            </div>
            {d.public_reply.enabled && d.public_reply.texts?.[0] && (
              <div className="preview-comment reply">
                <Avatar url={status.profile_picture_url} username={username} />
                <div>
                  <strong>{username}</strong>
                  <p>{d.public_reply.texts[0]}</p>
                  <small>now · Reply</small>
                </div>
              </div>
            )}
            <div className="comment-emojis">❤️ 🙌 🔥 👏 😢 😍 😮 😂</div>
            <div className="comment-placeholder">
              Add a comment for {username}…
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
function Bubble({
  children,
  outgoing,
}: {
  children: React.ReactNode;
  outgoing?: boolean;
}) {
  return (
    <div className={`bubble ${outgoing ? "outgoing" : ""}`}>{children}</div>
  );
}
function Avatar({ url, username }: { url?: string; username: string }) {
  return url ? (
    <img
      className="preview-avatar"
      src={url}
      alt=""
      onError={(e) => {
        e.currentTarget.style.visibility = "hidden";
      }}
    />
  ) : (
    <span className="preview-avatar">{username[0].toUpperCase()}</span>
  );
}
