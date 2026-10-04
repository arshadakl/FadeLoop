import {
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  Archive,
  Download,
  Folder,
  Grid2X2,
  List,
  ArrowLeft,
  Inbox,
  Mail,
  MessageCircle,
  MousePointer2,
  Package,
  Plus,
  Send,
  Trash2,
  Users,
} from "lucide-react";
import type { CampaignRow, Contact, DashboardData, Media } from "./types";
import type { Preferences } from "./App";
import { api, request } from "./lib/api";
import { useResource } from "./hooks/use-resource";
import { Button } from "./components/ui/button";
import { Checkbox } from "./components/ui/checkbox";
import { Badge } from "./components/ui/badge";
import { FolderManager, type FolderAction } from "./FolderManager";
import { FolderBrowser } from "./FolderBrowser";
import type { AutomationFolder } from "./types";
import {
  Choice,
  Empty,
  Failure,
  Loading,
  PageHeading,
  SearchField,
  StateBadge,
  timeAgo,
} from "./components/shared";

interface FilterProps {
  preferences: Preferences;
  setPreferences: Dispatch<SetStateAction<Preferences>>;
  revision: number;
  refresh(): void;
}
type Toast = (message: string, error?: boolean) => void;
export function Automations({
  campaigns,
  loading,
  error,
  media,
  preferences,
  setPreferences,
  revision,
  refresh,
  edit,
  archive,
  toast,
  openFolder,
}: FilterProps & {
  campaigns: CampaignRow[];
  loading: boolean;
  error?: string;
  media: Media[];
  edit(c: CampaignRow | null): void;
  archive(): void;
  toast: Toast;
  openFolder(folder: string, replace?: boolean): void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [grid, setGrid] = useState(() => {
    try { return localStorage.getItem("fadeloop_automation_view") === "grid"; } catch { return false; }
  });
  function toggleView() {
    const next = !grid;
    setGrid(next);
    try { localStorage.setItem("fadeloop_automation_view", next ? "grid" : "list"); } catch { /* The view still works when storage is unavailable. */ }
  }
  const [busy, setBusy] = useState(false);
  const folderFilter = preferences.folder;
  const [folderAction, setFolderAction] = useState<FolderAction | null>(null);
  const [moveTo, setMoveTo] = useState("");
  const folders = useResource<{ folders: AutomationFolder[] }>("/api/folders", revision);
  const folderList = folders.data?.folders || [];
  const currentFolder = folderFilter;
  const activeFolder = folderList.find(f => f.folder_id === currentFolder);
  const visibleFolders = folderList.filter(f => f.name.toLowerCase().includes(preferences.search.trim().toLowerCase()));
  const folderCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of campaigns) if (c.folder_id) counts.set(c.folder_id, (counts.get(c.folder_id) || 0) + 1);
    return counts;
  }, [campaigns]);
  useEffect(() => { setSelected(new Set()); }, [currentFolder]);
  useEffect(() => {
    if (currentFolder && !folders.loading && !folders.error && !activeFolder) {
      openFolder("", true); toast("This folder is no longer available. Returned to Automations.", true);
    }
  }, [currentFolder, folders.loading, folders.error, activeFolder, openFolder, toast]);
  async function move() {
    if (busy || !selected.size || selected.size > 100) return;
    setBusy(true);
    try {
      await api("/api/folders/move", { method: "POST", body: { campaign_ids: [...selected], folder_id: moveTo || null } });
      setSelected(new Set()); toast("Automations moved"); refresh();
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  }
  const [stats, setStats] = useState<
    Record<string, { runs: number; ctr: number }>
  >({});
  const rows = useMemo(
    () =>
      campaigns.filter(
        (c) =>
          (!preferences.search.trim() ||
            (c.name || c.campaign_id)
              .toLowerCase()
              .includes(preferences.search.trim().toLowerCase())) &&
          (currentFolder ? c.folder_id === currentFolder : !c.folder_id) &&
          (!preferences.state ||
            Boolean(c.active) === (preferences.state === "live")),
      ),
    [campaigns, preferences.search, preferences.state, currentFolder],
  );
  useEffect(() => {
    const ids = new Set(rows.map((c) => c.campaign_id));
    setSelected((previous) => {
      const next = new Set([...previous].filter((id) => ids.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [rows]);
  useEffect(() => {
    const controller = new AbortController();
    Promise.all(
      campaigns.map(async (c) => {
        try {
          const data = await api<DashboardData>(
            `/api/dashboard?campaign_id=${encodeURIComponent(c.campaign_id)}&days=3650`,
            { signal: controller.signal },
          );
          return [
            c.campaign_id,
            { runs: data.cards.sends, ctr: data.cards.ctr },
          ] as const;
        } catch {
          return [c.campaign_id, { runs: 0, ctr: 0 }] as const;
        }
      }),
    ).then((result) => {
      if (!controller.signal.aborted) setStats(Object.fromEntries(result));
    });
    return () => controller.abort();
  }, [campaigns, revision]);
  async function mutate(action: "archive" | "delete") {
    if (!selected.size || busy) return;
    if (
      action === "delete" &&
      !confirm(
        `Delete ${selected.size === 1 ? "this automation" : `these ${selected.size} automations`}? This can't be undone.`,
      )
    )
      return;
    setBusy(true);
    try {
      const result = await Promise.allSettled(
        [...selected].map((campaign_id) =>
          api(`/api/campaigns/${action}`, {
            method: "POST",
            body: {
              campaign_id,
              ...(action === "archive" ? { archived: true } : {}),
            },
          }),
        ),
      );
      const failed = result.find((item) => item.status === "rejected");
      if (failed?.status === "rejected") toast(failed.reason.message, true);
      else
        toast(
          action === "archive" ? "Automation archived" : "Automation deleted",
        );
      setSelected(new Set());
      refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeading
        title={activeFolder?.name || "My automations"}
        subtitle={currentFolder ? "Automations in this folder." : "Every comment-to-DM funnel in this instance."}
      >
        <Button onClick={() => edit(null)}>
          <Plus />
          New automation
        </Button>
      </PageHeading>
      {currentFolder && <nav className="folder-breadcrumbs" aria-label="Folder breadcrumbs">
        <Button variant="ghost" onClick={() => openFolder("")} aria-label="Back to Automations"><ArrowLeft />Back</Button>
        <button type="button" onClick={() => openFolder("")}>Automations</button><span aria-hidden="true">/</span><span aria-current="page">{activeFolder?.name || "Folder"}</span>
      </nav>}
      <div className="automation-filters">
        <SearchField
          label="Search automations"
          value={preferences.search}
          onChange={(search) => setPreferences((p) => ({ ...p, search }))}
        />
        <Choice
          label="Trigger type"
          value="comment"
          onChange={() => {}}
          options={[{ value: "comment", label: "Any trigger" }]}
        />
        <Choice
          label="Automation status"
          value={preferences.state}
          onChange={(state) => setPreferences((p) => ({ ...p, state }))}
          options={[
            { value: "", label: "Any trigger states" },
            { value: "live", label: "Live" },
            { value: "stopped", label: "Stopped" },
          ]}
        />
      </div>
      <div className="list-toolbar">
        {!currentFolder && <Button variant="outline" onClick={() => setFolderAction({ kind: "create" })}>
          <Folder />
          New folder
        </Button>}
        {currentFolder && activeFolder && <Button variant="outline" onClick={() => setFolderAction({ kind: "rename", folder: activeFolder })}>Rename folder</Button>}
        <div>
          <Button variant="ghost" onClick={archive}>
            <Archive />
            Archive
          </Button>
          <Button variant="ghost" onClick={toggleView} aria-pressed={grid}>
            {grid ? <List /> : <Grid2X2 />}
            {grid ? "View as list" : "View as grid"}
          </Button>
        </div>
      </div>
      {folders.error && <Failure message={folders.error} retry={refresh} />}
      <FolderManager action={folderAction} close={() => setFolderAction(null)} refresh={refresh} />
      {!currentFolder && (folders.loading && !folders.data ? <Loading /> : <FolderBrowser folders={visibleFolders} counts={folderCounts} open={openFolder} action={setFolderAction} />)}
      <h2 className="automation-location-heading">{currentFolder ? "Automations" : "Unfiled automations"}</h2>
      {loading ? (
        <Loading />
      ) : error ? (
        <Failure message={error} retry={refresh} />
      ) : (
        <section
          className={`panel automation-list ${grid ? "grid-view" : ""} ${!rows.length ? "empty-list" : ""}`}
          aria-label="Automation list"
        >
          {selected.size > 0 && (
            <div className="bulk-actions">
              <strong>{selected.size} selected</strong>
              <Choice label="Move selected to folder" value={moveTo} onChange={setMoveTo} disabled={busy || folders.loading} options={[
                { value: "", label: "Unfiled" }, ...folderList.map(f => ({ value: f.folder_id, label: f.name }))
              ]} />
              <Button variant="outline" disabled={busy || folders.loading || selected.size > 100} onClick={() => void move()}>Move selected</Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => mutate("archive")}
              >
                <Archive />
                Archive selected
              </Button>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() => mutate("delete")}
              >
                <Trash2 />
                Delete selected
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => setSelected(new Set())}
              >
                Cancel selection
              </Button>
            </div>
          )}
          {!rows.length ? (
            <Empty>
              {preferences.search.trim() || preferences.state
                ? "No automations match your search."
                : currentFolder ? "This folder is empty. Create an automation here or move one into this folder."
                : folderList.length ? "No unfiled automations. Open a folder to see its automations."
                : 'No automations yet. Tap "+ New automation" to build your first comment-to-DM funnel.'}
            </Empty>
          ) : (
            <>
              <div className="automation-list-heading">
                <span />
                <span>Name</span>
                <span>Runs</span>
                <span>CTR</span>
                <span>Modified</span>
              </div>
              <div className={grid ? "automation-grid" : "automation-rows"}>
              {rows.map((c) => {
                const metric = stats[c.campaign_id];
                const thumbnail = media.find((m) => m.id === c.media_id);
                return (
                  <div
                    key={c.campaign_id}
                    role="group"
                    tabIndex={0}
                    aria-label={c.name || c.campaign_id}
                    className={`automation-row ${selected.has(c.campaign_id) ? "selected" : ""}`}
                    onClick={() => edit(c)}
                    onKeyDown={(e) => {
                      if (
                        e.target === e.currentTarget &&
                        ["Enter", " "].includes(e.key)
                      ) {
                        e.preventDefault();
                        edit(c);
                      }
                    }}
                  >
                    <div
                      className="row-selection"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Checkbox
                        aria-label={`Select ${c.name || c.campaign_id}`}
                        checked={selected.has(c.campaign_id)}
                        disabled={busy}
                        onCheckedChange={(checked) =>
                          setSelected((previous) => {
                            const next = new Set(previous);
                            if (checked) next.add(c.campaign_id);
                            else next.delete(c.campaign_id);
                            return next;
                          })
                        }
                      />
                    </div>
                    <div className="automation-name">
                      <div>
                        <StateBadge active={c.active} />
                        <strong>{c.name || c.campaign_id}</strong>
                      </div>
                      <p>
                        {thumbnail && (
                          <img
                            src={thumbnail.thumbnail_url || thumbnail.media_url}
                            alt=""
                          />
                        )}
                        <span>{c.match_mode === "any" ? "User leaves any comment" : "User comments and comment contains"}</span>
                        <Badge variant="secondary">
                          {c.match_mode === "any" ? "Any comment" : c.keywords[0] || "—"}
                        </Badge>
                      </p>
                      {c.folder_id && <small>{folderList.find(f => f.folder_id === c.folder_id)?.name}</small>}
                    </div>
                    <div className="row-detail">
                      <small>Runs</small>
                      <strong>{metric?.runs ?? "—"}</strong>
                    </div>
                    <div className="row-detail">
                      <small>CTR</small>
                      <strong>
                        {metric
                          ? metric.runs
                            ? `${metric.ctr}%`
                            : "n/a"
                          : "—"}
                      </strong>
                    </div>
                    <div className="row-detail modified">
                      <small>Modified</small>
                      {timeAgo(c.updated_at)}
                    </div>
                  </div>
                );
              })}
              </div>
            </>
          )}
        </section>
      )}
    </>
  );
}
export function ArchivePage({
  preferences,
  setPreferences,
  revision,
  refresh,
  toast,
}: FilterProps & { toast: Toast }) {
  const result = useResource<{ campaigns: CampaignRow[] }>(
    "/api/campaigns?archived=1",
    revision,
  );
  const [busy, setBusy] = useState(false);
  const all = result.data?.campaigns || [];
  const rows = all.filter((c) =>
    (c.name || c.campaign_id)
      .toLowerCase()
      .includes(preferences.archiveSearch.trim().toLowerCase()),
  );
  async function mutate(campaign_id: string, remove: boolean) {
    if (
      busy ||
      (remove &&
        !confirm("Permanently delete this automation? This can't be undone."))
    )
      return;
    setBusy(true);
    try {
      await api(remove ? "/api/campaigns/delete" : "/api/campaigns/archive", {
        method: "POST",
        body: { campaign_id, ...(remove ? {} : { archived: false }) },
      });
      toast(remove ? "Automation permanently deleted" : "Automation restored");
      refresh();
    } catch (error) {
      toast((error as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeading
        title="Archive"
        subtitle="Stopped automations, kept out of the way. Restore them at any time."
      />
      <div className="archive-search">
        <SearchField
          label="Search archived automations"
          value={preferences.archiveSearch}
          onChange={(archiveSearch) =>
            setPreferences((p) => ({ ...p, archiveSearch }))
          }
        />
      </div>
      {result.loading ? (
        <Loading />
      ) : result.error ? (
        <Failure message={result.error} retry={refresh} />
      ) : (
        <section
          className={`panel ${!rows.length ? "empty-list" : ""}`}
          aria-label="Archived automations"
        >
          {!rows.length ? (
            <Empty icon={<Archive size={42} />}>
              {all.length
                ? "No archived automations match your search."
                : "Nothing archived. Archive an automation to keep it around without it running."}
            </Empty>
          ) : (
            rows.map((c) => (
              <article
                key={c.campaign_id}
                className="archive-row"
                aria-label={c.name || c.campaign_id}
              >
                <div>
                  <StateBadge active={false} archived />
                  <h2>{c.name || c.campaign_id}</h2>
                  <p>
                    User comments and comment contains{" "}
                    <Badge variant="secondary">{c.keywords[0]}</Badge>
                  </p>
                  <small>Archived {timeAgo(c.updated_at)}</small>
                </div>
                <div className="archive-actions">
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => mutate(c.campaign_id, false)}
                  >
                    Restore
                  </Button>
                  <Button
                    variant="ghost"
                    className="danger-text"
                    disabled={busy}
                    onClick={() => mutate(c.campaign_id, true)}
                  >
                    <Trash2 />
                    Delete
                  </Button>
                </div>
              </article>
            ))
          )}
        </section>
      )}
    </>
  );
}
const metricItems = [
  { key: "comments", label: "Comments", icon: MessageCircle },
  { key: "sends", label: "Opening DMs", icon: Send },
  { key: "clicks", label: "Clicks", icon: MousePointer2 },
  { key: "follows", label: "Follows", icon: Users },
  { key: "emails", label: "Emails", icon: Mail },
  { key: "delivered", label: "Delivered", icon: Package },
] as const;
const funnelIcons = [MessageCircle, MousePointer2, Users, Mail, Package];
export function Dashboard({
  campaigns,
  preferences,
  setPreferences,
  revision,
  refresh,
}: FilterProps & { campaigns: CampaignRow[] }) {
  const query = new URLSearchParams({ days: preferences.days });
  if (preferences.dashboardCampaign)
    query.set("campaign_id", preferences.dashboardCampaign);
  const result = useResource<DashboardData>(
    "/api/dashboard?" + query,
    revision,
  );
  return (
    <>
      <PageHeading
        title="Dashboard"
        subtitle="Performance from logged funnel events."
      >
        <div className="filter-field">
          <span>Campaign</span>
          <Choice
            label="Dashboard campaign"
            value={preferences.dashboardCampaign}
            onChange={(dashboardCampaign) =>
              setPreferences((p) => ({ ...p, dashboardCampaign }))
            }
            options={[
              { value: "", label: "All campaigns" },
              ...campaigns.map((c) => ({
                value: c.campaign_id,
                label: c.name || c.campaign_id,
              })),
            ]}
          />
        </div>
        <div className="filter-field">
          <span>Range</span>
          <Choice
            label="Dashboard date range"
            value={preferences.days}
            onChange={(days) => setPreferences((p) => ({ ...p, days }))}
            options={["7", "30", "90"].map((value) => ({
              value,
              label: `Last ${value} days`,
            }))}
          />
        </div>
      </PageHeading>
      {result.loading ? (
        <Loading />
      ) : result.error ? (
        <Failure message={result.error} retry={refresh} />
      ) : (
        result.data && (
          <>
            <section className="metrics" aria-label="Dashboard metrics">
              {metricItems.map((item) => (
                <article className="panel metric" key={item.key}>
                  <span className="icon-tile">
                    <item.icon size={23} />
                  </span>
                  <strong>
                    {result.data!.cards[item.key].toLocaleString()}
                  </strong>
                  <span>{item.label}</span>
                  {item.key === "clicks" && (
                    <small>{result.data!.cards.ctr}% of DMs</small>
                  )}
                </article>
              ))}
            </section>
            <section className="panel funnel-panel">
              <h2>Conversion funnel</h2>
              <p>Percentages are relative to comments with the keyword.</p>
              <div className="funnel-head">
                <span>Stage</span>
                <span>Count</span>
                <span>Conversion</span>
              </div>
              <div className="funnel">
                {result.data.funnel.map((stage, i) => {
                  const Icon = funnelIcons[i] || Package;
                  return (
                    <div
                      className={`funnel-row ${i === 0 ? "first" : ""}`}
                      key={stage.label}
                    >
                      <span className="funnel-icon">
                        <Icon />
                      </span>
                      <strong>{stage.label}</strong>
                      <div className="funnel-track">
                        <div
                          style={{
                            width: `${Math.min(100, Math.max(0, stage.pct))}%`,
                          }}
                        />
                      </div>
                      <span className="funnel-count">
                        {stage.value.toLocaleString()}
                      </span>
                      <Badge variant="secondary">{stage.pct}%</Badge>
                    </div>
                  );
                })}
              </div>
            </section>
          </>
        )
      )}
    </>
  );
}
export function Contacts({
  campaigns,
  preferences,
  setPreferences,
  revision,
  refresh,
  toast,
}: FilterProps & { campaigns: CampaignRow[]; toast: Toast }) {
  const query = new URLSearchParams();
  if (preferences.contactsCampaign)
    query.set("campaign_id", preferences.contactsCampaign);
  const result = useResource<{ contacts: Contact[] }>(
    "/api/contacts?" + query,
    revision,
  );
  const [busy, setBusy] = useState(false);
  const rows = result.data?.contacts || [];
  async function exportCsv() {
    if (busy) return;
    setBusy(true);
    try {
      const response = await request("/api/contacts/export?" + query);
      const href = URL.createObjectURL(await response.blob());
      const a = document.createElement("a");
      a.href = href;
      a.download = "fadeloop-contacts.csv";
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
    } catch (error) {
      toast("Export failed: " + (error as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeading title="Contacts" subtitle="Everyone who entered a campaign.">
        <div className="filter-field">
          <span>Campaign</span>
          <Choice
            label="Contacts campaign"
            value={preferences.contactsCampaign}
            onChange={(contactsCampaign) =>
              setPreferences((p) => ({ ...p, contactsCampaign }))
            }
            options={[
              { value: "", label: "All campaigns" },
              ...campaigns.map((c) => ({
                value: c.campaign_id,
                label: c.name || c.campaign_id,
              })),
            ]}
          />
        </div>
        <Button variant="outline" disabled={busy} onClick={exportCsv}>
          <Download />
          {busy ? "Exporting…" : "Export CSV"}
        </Button>
      </PageHeading>
      {result.loading ? (
        <Loading />
      ) : result.error ? (
        <Failure message={result.error} retry={refresh} />
      ) : (
        <section className="panel contacts-list" aria-label="Contacts list">
          {rows.length === 0 ? (
            <Empty icon={<Inbox size={43} />}>
              No contacts yet. Once people comment your keyword, they’ll appear
              here.
            </Empty>
          ) : (
            <>
              <div className="contacts-head">
                <span>Contact</span>
                <span>Campaign & status</span>
                <span>Follow</span>
                <span>Email</span>
                <span>Updated</span>
              </div>
              {rows.map((r) => (
                <article
                  className="contact-row"
                  key={`${r.igsid}:${r.campaign_id}`}
                >
                  <div className="contact-person">
                    <span className="avatar">
                      {(r.username || "?")[0].toUpperCase()}
                    </span>
                    <strong>{r.username ? `@${r.username}` : r.igsid}</strong>
                  </div>
                  <div className="contact-state">
                    <small>
                      {campaigns.find((c) => c.campaign_id === r.campaign_id)
                        ?.name || r.campaign_id}
                    </small>
                    <Badge
                      variant="secondary"
                      className={r.state === "DONE" ? "live" : ""}
                    >
                      {r.status_label}
                    </Badge>
                  </div>
                  <div className="contact-detail">
                    <small>Follow</small>
                    {r.followed ? "✓ followed" : "—"}
                  </div>
                  <div className="contact-detail">
                    <small>Email</small>
                    <span>{r.email || "—"}</span>
                  </div>
                  <div className="contact-detail">
                    <small>Updated</small>
                    {new Date(r.updated_at * 1000).toLocaleDateString()}
                  </div>
                </article>
              ))}
            </>
          )}
        </section>
      )}
    </>
  );
}
