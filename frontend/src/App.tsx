import { useCallback, useEffect, useRef, useState } from "react";
import {
  Archive,
  BarChart3,
  ChevronDown,
  CircleUserRound,
  Grid2X2,
  LogOut,
  Plus,
  Settings2,
  Users,
  Zap,
  Eye,
  EyeOff,
  LoaderCircle,
} from "lucide-react";
import type { CampaignRow, Media, Page, Session, Status } from "./types";
import { api } from "./lib/api";
import { defaultDraft, draftFromCampaign, type Draft } from "./lib/campaign";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import { Brand, Choice, Failure, Field, Loading } from "./components/shared";
import { useResource } from "./hooks/use-resource";
import { Automations, ArchivePage, Dashboard, Contacts } from "./pages";
import { Builder } from "./Builder";
import { DisconnectSettings } from "./DisconnectSettings";
import { PasswordSettings } from "./PasswordSettings";
import { readWorkspaceLocation, useWorkspaceHistory } from "./hooks/use-workspace-history";

const navigation = [
  { page: "automations", label: "Automations", icon: Zap },
  { page: "create", label: "Create", icon: Plus },
  { page: "dashboard", label: "Dashboard", icon: BarChart3 },
  { page: "contacts", label: "Contacts", icon: Users },
  { page: "archive", label: "Archive", icon: Archive },
] as const;
export interface Preferences {
  folder: string;
  search: string;
  state: string;
  archiveSearch: string;
  days: string;
  dashboardCampaign: string;
  contactsCampaign: string;
}
export function App() {
  const [session, setSession] = useState<Session | null | undefined>();
  const [message, setMessage] = useState("");
  const [bootKey, setBootKey] = useState(0);
  const [workspaceReset, setWorkspaceReset] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    try {
      localStorage.removeItem("fadeloop_token");
      localStorage.removeItem("chatmany_token");
    } catch {}
    api<Session>("/session", { signal: controller.signal, session: false })
      .then((value) => {
        if (!controller.signal.aborted) setSession(value);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setSession(null);
          setMessage(error.status === 401 ? "" : error.message);
        }
      });
    return () => controller.abort();
  }, [bootKey]);
  useEffect(() => {
    const ended = () => {
      setSession(null);
      setMessage("Your session has ended. Please sign in again.");
    };
    window.addEventListener("fadeloop:session-ended", ended);
    return () => window.removeEventListener("fadeloop:session-ended", ended);
  }, []);
  useEffect(() => {
    document.title = session ? "FadeLoop" : "Sign in | FadeLoop";
  }, [session]);
  useEffect(() => {
    const sync = () =>
      document.documentElement.classList.toggle(
        "keyboard-open",
        Boolean(
          document.activeElement?.matches(
            'input, textarea, [role="combobox"]',
          ) &&
            innerHeight - (window.visualViewport?.height || innerHeight) > 140,
        ),
      );
    window.visualViewport?.addEventListener("resize", sync);
    document.addEventListener("focusin", sync);
    document.addEventListener("focusout", sync);
    return () => {
      window.visualViewport?.removeEventListener("resize", sync);
      document.removeEventListener("focusin", sync);
      document.removeEventListener("focusout", sync);
      document.documentElement.classList.remove("keyboard-open");
    };
  }, []);
  if (session === undefined) return <Loading />;
  if (!session)
    return (
      <Login
        message={message}
        onLogin={setSession}
        retry={() => {
          setSession(undefined);
          setBootKey((x) => x + 1);
        }}
      />
    );
  return (
    <Workspace
      key={`${session.email}:${workspaceReset}`}
      resetNotice={workspaceReset > 0}
      onReset={() => { history.replaceState(history.state, "", "#automations"); setWorkspaceReset(n => n + 1); }}
      session={session}
      onSession={setSession}
      onLogout={() => {
        setSession(null);
        setMessage("");
      }}
    />
  );
}
function Login({
  message,
  onLogin,
  retry,
}: {
  message: string;
  onLogin(s: Session): void;
  retry(): void;
}) {
  const [error, setError] = useState(message);
  const [busy, setBusy] = useState(false);
  const [visible, setVisible] = useState(false);
  const [appearance, setAppearance] = useState(false);
  const email = useRef<HTMLInputElement>(null);
  const password = useRef<HTMLInputElement>(null);
  useEffect(() => setError(message), [message]);
  return (
    <main className="login-page">
      <section className="login-card">
        <Brand />
        <div className="eyebrow">YOUR CREATOR WORKSPACE</div>
        <h1>Welcome back</h1>
        <p>
          Sign in to manage your automations and turn conversations into
          connections.
        </p>
        <form
          aria-label="Sign in"
          onSubmit={async (e) => {
            e.preventDefault();
            if (busy) return;
            setBusy(true);
            setError("");
            try {
              const length = [...password.current!.value].length;
              if (length < 8 || length > 128)
                throw new Error("Password must contain 8–128 characters.");
              const value = await api<Session>("/session/login", {
                method: "POST",
                body: {
                  email: email.current!.value,
                  password: password.current!.value,
                },
                session: false,
              });
              password.current!.value = "";
              onLogin(value);
            } catch (failure) {
              if (password.current) password.current.value = "";
              setVisible(false);
              setError((failure as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {error && <Failure message={error} />}
          <Field label="Email address">
            <Input
              ref={email}
              name="email"
              type="email"
              autoComplete="username"
              placeholder="you@example.com"
              maxLength={254}
              required
              disabled={busy}
            />
          </Field>
          <Field label="Password" hint="Use 8–128 characters.">
            <span className="password-field">
              <Input
                ref={password}
                name="password"
                type={visible ? "text" : "password"}
                autoComplete="current-password"
                maxLength={256}
                required
                disabled={busy}
              />
              <Button
                type="button"
                variant="ghost"
                aria-label={visible ? "Hide password" : "Show password"}
                aria-pressed={visible}
                onClick={() => setVisible((v) => !v)}
              >
                {visible ? <EyeOff /> : <Eye />}
              </Button>
            </span>
          </Field>
          <Button type="submit" className="sign-in-button" disabled={busy}>
            {busy && <LoaderCircle className="animate-spin" />}
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </form>
        <p className="recovery">
          Forgot your password? Contact your instance administrator to reset it.
        </p>
        <footer>
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
          <Button variant="ghost" onClick={() => setAppearance(true)}>
            Appearance
          </Button>
        </footer>
        {error.includes("connect") && (
          <Button variant="outline" onClick={retry}>
            Retry connection
          </Button>
        )}
        <AccountDialog open={appearance} onOpenChange={setAppearance} />
      </section>
    </main>
  );
}
function Workspace({
  resetNotice,
  onReset,
  session,
  onLogout,
  onSession,
}: {
  resetNotice: boolean;
  onReset(): void;
  session: Session;
  onLogout(): void;
  onSession(session: Session): void;
}) {
  const [initialLocation] = useState(readWorkspaceLocation);
  const [page, setPage] = useState<Page>(initialLocation.page);
  const [account, setAccount] = useState(false);
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState<{
    message: string;
    error: boolean;
  } | null>(resetNotice ? { message: "Instagram disconnected. All workspace automation data was deleted. You remain signed in.", error: false } : null);
  const [draft, setDraft] = useState<Draft | null>(() => initialLocation.page === "create" ? defaultDraft() : null);
  const [saved, setSaved] = useState(() => initialLocation.page === "create" ? JSON.stringify(defaultDraft()) : "");
  const [draftGeneration, setDraftGeneration] = useState(0);
  const [preferences, setPreferences] = useState<Preferences>({
    folder: initialLocation.folder,
    search: "",
    state: "",
    archiveSearch: "",
    days: "30",
    dashboardCampaign: "",
    contactsCampaign: "",
  });
  const status = useResource<Status>("/api/status", revision);
  const campaigns = useResource<{ campaigns: CampaignRow[] }>(
    "/api/campaigns",
    revision,
  );
  const [media, setMedia] = useState<Media[]>([]);
  const [mediaError, setMediaError] = useState("");
  const [mediaLoading, setMediaLoading] = useState(false);
  const [mediaRevision, setMediaRevision] = useState(0);
  useEffect(() => {
    // Back from Instagram can restore the pre-connection dashboard from bfcache.
    const restored = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      setRevision(value => value + 1);
      setMediaRevision(value => value + 1);
    };
    window.addEventListener("pageshow", restored);
    return () => window.removeEventListener("pageshow", restored);
  }, []);
  useEffect(() => {
    if (!status.data?.connected || status.data.token_expired) return;
    const controller = new AbortController();
    setMediaLoading(true);
    setMediaError("");
    api<{ media: Media[] }>("/api/media", { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setMedia(data.media || []);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setMediaError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setMediaLoading(false);
      });
    return () => controller.abort();
  }, [status.data?.connected, status.data?.token_expired, mediaRevision]);
  const dirty =
    page === "create" && draft !== null && JSON.stringify(draft) !== saved;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, []);
  const toast = useCallback(
    (message: string, error = false) => setNotice({ message, error }),
    [],
  );
  useEffect(() => {
    if (notice) {
      const timer = setTimeout(() => setNotice(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [notice]);
  const discard = () =>
    !dirty ||
    confirm(
      `You have unsaved changes to "${draft?.name || "this automation"}".\n\nThey will NOT take effect until you save. OK to discard them, or Cancel to go back and save.`,
    );
  const writeLocation = useWorkspaceHistory(initialLocation, discard, location => {
    if (dirty && saved) setDraft(JSON.parse(saved));
    if (location.page === "create" && !draft) {
      const value = defaultDraft(); setDraft(value); setSaved(JSON.stringify(value));
    }
    setPage(location.page);
    if (location.page === "automations") setPreferences(p => ({ ...p, folder: location.folder, search: p.folder === location.folder ? p.search : "" }));
    setAccount(false);
    window.scrollTo(0, 0);
  });
  const openFolder = (folder: string, replace = false) => {
    if (!discard()) return;
    setPreferences(p => ({ ...p, folder, search: p.folder === folder ? p.search : "" }));
    setPage("automations");
    writeLocation({ page: "automations", folder }, replace);
    window.scrollTo(0, 0);
  };
  const navigate = (next: Page, campaign?: CampaignRow | null) => {
    if ((next !== page || campaign !== undefined) && !discard()) return false;
    if (next === "create") {
      if (campaign !== undefined || !draft) {
        const value = campaign
          ? draftFromCampaign(campaign, media)
          : { ...defaultDraft(), folder_id: preferences.folder || null };
        setDraft(value);
        setSaved(JSON.stringify(value));
        setDraftGeneration((v) => v + 1);
      }
    } else if (dirty && saved) setDraft(JSON.parse(saved));
    setPage(next);
    writeLocation({ page: next, folder: next === "automations" ? preferences.folder : "" });
    setAccount(false);
    window.scrollTo(0, 0);
    return true;
  };
  const refresh = () => setRevision((v) => v + 1);
  const rows = campaigns.data?.campaigns || [];
  const links = (mobile = false) =>
    navigation
      .filter((n) => !mobile || n.page !== "archive")
      .map((n) => (
        <Button
          key={n.page}
          variant="ghost"
          className={`nav-link ${page === n.page ? "active" : ""}`}
          aria-current={page === n.page ? "page" : undefined}
          onClick={() => navigate(n.page)}
        >
          <n.icon />
          <span>{n.label}</span>
        </Button>
      ));
  const connected = status.data?.connected;
  return (
    <div className="workspace">
      <header className="mobile-header">
        <Brand />
        <Button
          variant="ghost"
          size="icon"
          aria-label="Open account menu"
          onClick={() => setAccount(true)}
        >
          <CircleUserRound />
        </Button>
      </header>
      <aside className="sidebar">
        <Brand />
        <nav aria-label="Sidebar navigation">{links()}</nav>
        <div className="sidebar-footer">
          <Button
            variant="outline"
            className="account-button"
            onClick={() => setAccount(true)}
          >
            <Settings2 />
            Account & appearance
          </Button>
          <div className="profile">
            {status.data?.profile_picture_url ? (
              <img
                src={status.data.profile_picture_url}
                alt=""
                onError={(e) => {
                  e.currentTarget.style.visibility = "hidden";
                }}
              />
            ) : (
              <span className="avatar">
                <CircleUserRound />
              </span>
            )}
            <div>
              <strong>
                {connected
                  ? `@${status.data?.username || "account"}`
                  : "Not connected"}
              </strong>
              <small>self-hosted</small>
            </div>
          </div>
          <div className="legal-links">
            <a href="/privacy" target="_blank" rel="noopener">
              Privacy
            </a>
            <span>·</span>
            <a href="/data-deletion" target="_blank" rel="noopener">
              Data deletion
            </a>
          </div>
        </div>
      </aside>
      <main
        className={`workspace-main ${page === "create" ? "is-builder" : ""}`}
      >
        <div className="main-content">
          {status.loading && !status.data ? (
            <Loading />
          ) : status.error ? (
            <Failure message={status.error} retry={refresh} />
          ) : (
            <>
              {connected && status.data?.token_expired && (
                <div className="connection-banner" role="status">
                  Your Instagram token expired. Reconnect to resume.
                  <a href="/auth/authorize">Reconnect Instagram</a>
                </div>
              )}
              {!connected && (page === "automations" || page === "create") ? (
                <section className="connection-gate panel">
                  <span className="icon-tile">
                    <Zap />
                  </span>
                  <h1>Connect Instagram first</h1>
                  <p>
                    Connect your Instagram Professional account to choose posts
                    and build your first automation.
                  </p>
                  <Button asChild>
                    <a href="/auth/authorize">Connect Instagram</a>
                  </Button>
                  <small>
                    You’ll approve access on Instagram’s own page. FadeLoop
                    never sees your password.
                  </small>
                </section>
              ) : (
                <>
                  {page === "automations" && (
                    <Automations
                      campaigns={rows}
                      loading={campaigns.loading}
                      error={campaigns.error}
                      media={media}
                      preferences={preferences}
                      setPreferences={setPreferences}
                      revision={revision}
                      refresh={refresh}
                      edit={(c) => navigate("create", c)}
                      archive={() => navigate("archive")}
                      toast={toast}
                      openFolder={openFolder}
                    />
                  )}
                  {page === "archive" && (
                    <ArchivePage
                      preferences={preferences}
                      setPreferences={setPreferences}
                      revision={revision}
                      refresh={refresh}
                      toast={toast}
                    />
                  )}
                  {page === "create" && draft && (
                    <Builder
                      key={draftGeneration}
                      draft={draft}
                      setDraft={setDraft}
                      dirty={dirty}
                      markSaved={(value) => {
                        setDraft(value);
                        setSaved(JSON.stringify(value));
                      }}
                      campaigns={rows}
                      media={media}
                      status={status.data!}
                      mediaError={mediaError}
                      mediaLoading={mediaLoading}
                      retryMedia={() => setMediaRevision((v) => v + 1)}
                      load={(c) => navigate("create", c)}
                      done={() => {
                        setPage("automations");
                        writeLocation({ page: "automations", folder: preferences.folder });
                        refresh();
                        window.scrollTo(0, 0);
                      }}
                      toast={toast}
                    />
                  )}
                  {page === "dashboard" && (
                    <Dashboard
                      campaigns={rows}
                      preferences={preferences}
                      setPreferences={setPreferences}
                      revision={revision}
                      refresh={refresh}
                    />
                  )}
                  {page === "contacts" && (
                    <Contacts
                      campaigns={rows}
                      preferences={preferences}
                      setPreferences={setPreferences}
                      revision={revision}
                      refresh={refresh}
                      toast={toast}
                    />
                  )}
                </>
              )}
            </>
          )}
        </div>
      </main>
      <nav className="bottom-nav" aria-label="Mobile navigation">
        {links(true)}
        <Button
          variant="ghost"
          className={`nav-link ${page === "archive" ? "active" : ""}`}
          onClick={() => setAccount(true)}
        >
          <Grid2X2 />
          <span>More</span>
        </Button>
      </nav>
      <AccountDialog
        open={account}
        connection={status.data}
        dirty={dirty}
        onDisconnect={onReset}
        onSession={onSession}
        onOpenChange={setAccount}
        session={session}
        archive={() => navigate("archive")}
        logout={async () => {
          if (!discard()) return;
          try {
            await api("/session/logout", { method: "POST" });
            onLogout();
          } catch (error) {
            toast((error as Error).message, true);
          }
        }}
      />
      {notice && (
        <div
          className={`toast ${notice.error ? "error" : ""}`}
          role={notice.error ? "alert" : "status"}
        >
          {notice.message}
        </div>
      )}
    </div>
  );
}
function AccountDialog({
  connection,
  dirty = false,
  onDisconnect,
  open,
  onOpenChange,
  session,
  archive,
  logout,
  onSession,
}: {
  connection?: Status;
  dirty?: boolean;
  onDisconnect?: () => void;
  open: boolean;
  onOpenChange(open: boolean): void;
  session?: Session;
  archive?: () => void;
  logout?: () => Promise<void>;
  onSession?: (session: Session) => void;
}) {
  const [theme, setTheme] = useState(window.fadeTheme.get());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setTheme(window.fadeTheme.get());
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="account-dialog">
        <DialogHeader>
          <DialogTitle>{session ? "Your workspace" : "Appearance"}</DialogTitle>
          <DialogDescription>
            {session
              ? session.email
              : "Choose the appearance that works for you."}
          </DialogDescription>
        </DialogHeader>
        {archive && (
          <Button variant="outline" onClick={archive}>
            <Archive />
            Archive
          </Button>
        )}
        <div className="field">
          <span>Appearance</span>
          <Choice
            label="Appearance"
            value={theme}
            onChange={(value) => {
              setTheme(value);
              window.fadeTheme.set(value);
            }}
            options={["light", "dark", "system"].map((value) => ({
              value,
              label: value[0].toUpperCase() + value.slice(1),
            }))}
          />
        </div>
        {session && onSession && <PasswordSettings key={String(open)} changed={onSession} />}
        {connection?.connected && onDisconnect && <DisconnectSettings status={connection} dirty={dirty} done={onDisconnect} />}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline">
              Legal information
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {["privacy", "terms", "data-deletion"].map((path) => (
              <DropdownMenuItem key={path} asChild>
                <a href={`/${path}`} target="_blank" rel="noopener">
                  {path === "privacy"
                    ? "Privacy"
                    : path === "terms"
                      ? "Terms"
                      : "Data deletion"}
                </a>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {logout && (
          <Button
            variant="destructive"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await logout();
              } finally {
                setBusy(false);
              }
            }}
          >
            <LogOut />
            Sign out
          </Button>
        )}
        <Button
          variant="ghost"
          aria-label="Close menu"
          onClick={() => onOpenChange(false)}
        >
          Close
        </Button>
      </DialogContent>
    </Dialog>
  );
}
