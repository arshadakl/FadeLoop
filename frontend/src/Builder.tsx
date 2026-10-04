import {
  useState,
  type Dispatch,
  type SetStateAction,
  type ReactNode,
} from "react";
import {
  ChevronDown,
  CircleDot,
  LoaderCircle,
  Trash2,
} from "lucide-react";
import type { CampaignRow, Media, Status } from "./types";
import { api } from "./lib/api";
import {
  buildCampaignFromDraft,
  validateDraft,
  type Draft,
} from "./lib/campaign";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import { Switch } from "./components/ui/switch";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./components/ui/collapsible";
import { Choice, Failure, Field, StateBadge } from "./components/shared";
import { PhonePreview } from "./PhonePreview";
import { useResource } from "./hooks/use-resource";
import type { AutomationFolder } from "./types";

export function Builder({
  draft: d,
  setDraft,
  dirty,
  markSaved,
  campaigns,
  media,
  status,
  mediaError,
  mediaLoading,
  retryMedia,
  load,
  done,
  toast,
}: {
  draft: Draft;
  setDraft: Dispatch<SetStateAction<Draft | null>>;
  dirty: boolean;
  markSaved(d: Draft): void;
  campaigns: CampaignRow[];
  media: Media[];
  status: Status;
  mediaError: string;
  mediaLoading: boolean;
  retryMedia(): void;
  load(c: CampaignRow | null): void;
  done(): void;
  toast(message: string, error?: boolean): void;
}) {
  const [busy, setBusy] = useState(false);
  const folders = useResource<{ folders: AutomationFolder[] }>("/api/folders", 0);
  const [showAll, setShowAll] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(
    () => matchMedia("(min-width: 768px)").matches,
  );
  const [keywords, setKeywords] = useState(d.keywords.join(", "));
  const [exclude, setExclude] = useState(d.exclude.join(", "));
  const [replies, setReplies] = useState((d.public_reply.texts || []).join("\n"));
  const patch = (value: Partial<Draft>) =>
    setDraft((previous) => (previous ? { ...previous, ...value } : previous));
  const copy = (key: keyof Draft["copy"], value: string) =>
    setDraft((previous) =>
      previous
        ? { ...previous, copy: { ...previous.copy, [key]: value } }
        : previous,
    );
  const list = (value: string, separator = ",") =>
    value
      .split(separator)
      .map((v) => v.trim())
      .filter(Boolean);
  async function save(activation?: "activate" | "deactivate") {
    if (busy) return;
    const error = validateDraft(d);
    if (error && activation !== "deactivate") {
      toast(error, true);
      return;
    }
    setBusy(true);
    const campaign = buildCampaignFromDraft(d);
    const active =
      activation === "activate"
        ? true
        : activation === "deactivate"
          ? false
          : d.active;
    try {
      await api("/api/campaigns", {
        method: "POST",
        body: { campaign, active, folder_id: d.folder_id },
      });
      // Retain the assigned ID even if the separate activation request fails, avoiding duplicate drafts on retry.
      patch({ campaign_id: campaign.campaign_id });
      if (activation)
        await api("/api/campaigns/status", {
          method: "POST",
          body: { campaign_id: campaign.campaign_id, active },
        });
      markSaved({ ...d, campaign_id: campaign.campaign_id, active });
      toast(
        activation
          ? active
            ? "Automation is live"
            : "Automation stopped"
          : "Saved",
      );
      if (activation) done();
    } catch (error) {
      toast((error as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (
      busy ||
      !confirm(`Delete "${d.name || d.campaign_id}"? This can't be undone.`)
    )
      return;
    setBusy(true);
    try {
      await api("/api/campaigns/delete", {
        method: "POST",
        body: { campaign_id: d.campaign_id },
      });
      toast("Automation deleted");
      done();
    } catch (error) {
      toast((error as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="builder-topbar">
        <Input
          aria-label="Automation name"
          className="automation-title"
          value={d.name}
          disabled={busy}
          onChange={(e) => patch({ name: e.target.value })}
        />
        <StateBadge active={d.active} />
        <div className="builder-load">
          <Choice
            label="Load automation"
            disabled={busy}
            value={d.campaign_id}
            onChange={(id) =>
              load(campaigns.find((c) => c.campaign_id === id) || null)
            }
            options={[
              { value: "", label: "New automation…" },
              ...campaigns.map((c) => ({
                value: c.campaign_id,
                label: c.name || c.campaign_id,
              })),
            ]}
          />
        </div>
        {d.campaign_id && (
          <Button
            variant="ghost"
            className="danger-text builder-delete"
            disabled={busy}
            onClick={remove}
          >
            <Trash2 />
            Delete
          </Button>
        )}
        <div className="builder-actions">
          <Button
            variant={dirty ? "default" : "outline"}
            disabled={busy}
            title="Changes do not take effect until saved"
            onClick={() => save()}
          >
            {busy && <LoaderCircle className="animate-spin" />}
            {dirty ? "Save changes •" : "Save"}
          </Button>
          <Button
            disabled={busy}
            onClick={() => save(d.active ? "deactivate" : "activate")}
          >
            {d.active ? "Stop" : "Go live"}
          </Button>
        </div>
      </div>
      <div className="builder-grid">
        <fieldset
          disabled={busy}
          className="builder-sections"
          aria-label="Automation configuration"
        >
          <Section
            number={1}
            title="When someone comments on"
            hint="Pick the post or reel this automation watches."
          >
            <div className="radio-option selected">
              <CircleDot />
              <div>
                <strong>A specific post or reel</strong>
                <small>
                  Only comments on the selected media trigger the funnel.
                </small>
              </div>
            </div>
            <Field label="Folder">
              <Choice label="Automation folder" value={d.folder_id || ""} onChange={folder_id => patch({ folder_id: folder_id || null })}
                options={[{ value: "", label: "Unfiled" }, ...(folders.data?.folders || []).map(f => ({ value: f.folder_id, label: f.name }))]} />
            </Field>
            {folders.error && <p role="alert">{folders.error}</p>}
            {mediaError && <Failure message={mediaError} retry={retryMedia} />}
            {mediaLoading ? (
              <p role="status" className="muted">
                Loading your posts…
              </p>
            ) : (
              !media.length && (
                <p className="muted">
                  No posts available. You can still edit the copy and preview
                  below.
                </p>
              )
            )}
            <div className="media-picker">
              {(showAll ? media : media.slice(0, 5)).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={`media-thumbnail ${d.media_id === m.id ? "selected" : ""}`}
                  aria-label={`Select post ${m.caption || m.id}`}
                  aria-pressed={d.media_id === m.id}
                  onClick={() =>
                    patch({
                      media_id: m.id,
                      media_thumb: m.thumbnail_url || m.media_url || "",
                    })
                  }
                >
                  <img
                    src={m.thumbnail_url || m.media_url}
                    alt=""
                    loading="lazy"
                  />
                </button>
              ))}
            </div>
            {media.length > 5 && (
              <Button variant="ghost" onClick={() => setShowAll((v) => !v)}>
                {showAll ? "Show less" : `See more (${media.length - 5})`}
              </Button>
            )}
          </Section>
          <Section
            number={2}
            title="And this comment has"
            hint={
              "Whole-word match, case-insensitive — “ai” fires on “I like this ai”, not “fair”."
            }
          >
            <Choice label="Comment matching" value={d.match_mode} onChange={value => patch({ match_mode: value as Draft["match_mode"] })}
              options={[{ value: "keywords", label: "A specific word or words" }, { value: "any", label: "Any comment" }]} />
            {d.match_mode === "any" && <p className="muted">Any text or emoji comment qualifies, except excluded words. Only new comments after activation trigger this automation.</p>}
            {d.match_mode === "keywords" && <>
            <Field label="Keywords (comma separated)">
              <Input
                value={keywords}
                onChange={(e) => {
                  setKeywords(e.target.value);
                  patch({ keywords: list(e.target.value) });
                }}
                placeholder="Link, Guide"
              />
            </Field>
            <div className="keyword-chips">
              {["Price", "Link", "Shop"].map((word) => (
                <Button
                  key={word}
                  variant="secondary"
                  onClick={() => {
                    const words = [...new Set([...list(keywords), word])];
                    setKeywords(words.join(", "));
                    patch({ keywords: words });
                  }}
                >
                  {word}
                </Button>
              ))}
            </div>
            </>}
            <Field label="Exclude words (optional)">
              <Input
                value={exclude}
                onChange={(e) => {
                  setExclude(e.target.value);
                  patch({ exclude: list(e.target.value) });
                }}
                placeholder="scam, fake"
              />
            </Field>
            <Toggle
              label="Reply to their comment"
              accessible="Enable public reply"
              hint="Post a public reply under the comment, rotating your messages."
              checked={d.public_reply.enabled}
              onChange={(enabled) =>
                patch({ public_reply: { ...d.public_reply, enabled } })
              }
            />
            {d.public_reply.enabled && (
              <Field label="Public replies (one per line, rotated)">
                <Textarea
                  value={replies}
                  onChange={(e) => {
                    setReplies(e.target.value);
                    patch({
                      public_reply: {
                        ...d.public_reply,
                        texts: list(e.target.value, "\n"),
                      },
                    });
                  }}
                />
              </Field>
            )}
          </Section>
          <Section number={3} title="They will get">
            <Toggle
              label="An opening DM"
              accessible="Enable opening message"
              hint="A private reply with a button. Required to start the funnel."
              checked={d.opening_enabled}
              onChange={(opening_enabled) => patch({ opening_enabled })}
            />
            {d.opening_enabled && (
              <>
                <Field label="Opening message">
                  <Textarea
                    value={d.copy.opening}
                    onChange={(e) => copy("opening", e.target.value)}
                  />
                </Field>
                <Field
                  label="Button label"
                  hint="Instagram allows 20 characters on a button."
                >
                  <Input
                    maxLength={20}
                    value={d.copy.opening_button || ""}
                    onChange={(e) => copy("opening_button", e.target.value)}
                  />
                </Field>
              </>
            )}
            <Toggle
              label="Ask them to follow you first"
              accessible="Ask users to follow"
              hint="Their button tap advances the funnel; Instagram cannot verify a specific follow."
              checked={d.check_follow}
              onChange={(check_follow) => patch({ check_follow })}
            />
            {d.check_follow && (
              <>
                <Field label="Follow message">
                  <Textarea
                    value={d.copy.follow_gate || ""}
                    onChange={(e) => copy("follow_gate", e.target.value)}
                  />
                </Field>
                <Field
                  label="Follow button label"
                  hint="Instagram allows 20 characters on a button."
                >
                  <Input
                    maxLength={20}
                    value={d.copy.follow_button || ""}
                    onChange={(e) => copy("follow_button", e.target.value)}
                  />
                </Field>
              </>
            )}
            <Toggle
              label="Ask for their email"
              accessible="Ask for email"
              hint="Uses Instagram’s email chip, with a typed-reply fallback."
              checked={d.ask_email}
              onChange={(ask_email) => patch({ ask_email })}
            />
            {d.ask_email && (
              <Field label="Email ask message">
                <Textarea
                  value={d.copy.email_ask || ""}
                  onChange={(e) => copy("email_ask", e.target.value)}
                />
              </Field>
            )}
          </Section>
          <Section
            number={4}
            title="And then, they will get"
            hint="The reward, delivered by DM. Use {reward} to place your link."
          >
            <Field label="Delivery message">
              <Textarea
                value={d.copy.delivery}
                onChange={(e) => copy("delivery", e.target.value)}
              />
            </Field>
            <Field label="Link or reward">
              <Input
                type="url"
                value={d.reward.value}
                onChange={(e) =>
                  patch({ reward: { ...d.reward, value: e.target.value } })
                }
                placeholder="https://example.com/guide"
              />
            </Field>
          </Section>
        </fieldset>
        <Collapsible
          className="preview-column"
          open={previewOpen}
          onOpenChange={setPreviewOpen}
        >
          <CollapsibleTrigger asChild>
            <Button variant="outline" className="preview-trigger">
              <ChevronDown className={previewOpen ? "" : "-rotate-90"} />
              Live preview
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <PhonePreview draft={d} media={media} status={status} />
          </CollapsibleContent>
        </Collapsible>
      </div>
    </>
  );
}
function Section({
  number,
  title,
  hint,
  children,
}: {
  number: number;
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="panel builder-section">
      <h2>
        <span>{number}</span>
        {title}
      </h2>
      {hint && <p className="section-hint">{hint}</p>}
      {children}
    </section>
  );
}
function Toggle({
  label,
  accessible,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  accessible?: string;
  hint: string;
  checked: boolean;
  onChange?(checked: boolean): void;
  disabled?: boolean;
}) {
  return (
    <div className={`toggle-row ${disabled ? "unavailable" : ""}`}>
      <div>
        <strong>{label}</strong>
        <small>{hint}</small>
      </div>
      <Switch
        aria-label={accessible || label}
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
      />
    </div>
  );
}
