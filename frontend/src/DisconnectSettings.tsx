import { useRef, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import type { Status } from "./types";
import { api, ApiError } from "./lib/api";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Field } from "./components/shared";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "./components/ui/dialog";

export function DisconnectSettings({ status, dirty, done }: { status: Status; dirty: boolean; done(): void }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [message, setMessage] = useState("");
  const lock = useRef(false);
  const generation = useRef(status.connection_generation);
  function close(value: boolean) {
    if (lock.current) return;
    setPassword(""); setVisible(false); setOpen(value);
    if (value) {
      generation.current = status.connection_generation;
      setMessage(""); setUncertain(true); lock.current = true; setBusy(true);
      // Also verify on reopening: closing the account menu can unmount this component.
      void checkOutcome(true).finally(() => { lock.current = false; setBusy(false); });
    }
  }
  async function checkOutcome(opening = false) {
    try {
      const fresh = await api<Status>("/api/status");
      if (!fresh.connected && fresh.connection_generation === generation.current + 1) { done(); return; }
      setUncertain(false);
      if (fresh.connection_generation !== generation.current) {
        setMessage("Instagram connection changed. Close this dialog and refresh before disconnecting.");
        setUncertain(true);
      } else setMessage(opening ? "" : "The workspace is still connected. You can enter your password and try again.");
    } catch { setUncertain(true); setMessage("Unable to confirm the outcome. Check connection status before trying again."); }
  }
  async function submit() {
    if (lock.current || uncertain) return;
    lock.current = true; setBusy(true); setMessage("");
    try {
      const result = await api<{ disconnected: boolean; deleted: boolean }>("/auth/disconnect", { method: "POST", body: { password, connection_generation: generation.current } });
      if (!result.disconnected || !result.deleted) throw new ApiError("Unable to confirm disconnect.", 200);
      done();
    } catch (error) {
      if (error instanceof ApiError && (error.status === 0 || error.status === 200 || error.status >= 500)) {
        setUncertain(true); await checkOutcome();
      } else setMessage((error as Error).message);
    } finally { setPassword(""); setVisible(false); setBusy(false); lock.current = false; }
  }
  return <>
    <Dialog open={open} onOpenChange={close}>
      <DialogTrigger asChild><Button variant="destructive">Disconnect Instagram</Button></DialogTrigger>
      <DialogContent className="disconnect-dialog" showCloseButton={!busy} onEscapeKeyDown={e => { if (busy) e.preventDefault(); }} onPointerDownOutside={e => { if (busy) e.preventDefault(); }}>
        <DialogHeader>
          <DialogTitle>Disconnect Instagram{status.username ? ` @${status.username}` : ""}</DialogTitle>
          <DialogDescription>Disconnecting Instagram will permanently delete all automations—including active and archived automations—along with contacts, analytics, and folders from this workspace. This cannot be undone in FadeLoop. Your FadeLoop account will remain available.</DialogDescription>
        </DialogHeader>
        <p>{dirty ? "Your unsaved builder changes will also be discarded." : "Any unsaved builder changes will also be discarded."}</p>
        <p className="muted">This disconnects this workspace only. Messages already sent to Instagram cannot be recalled.</p>
        <form onSubmit={e => { e.preventDefault(); void submit(); }}>
          <Field label="FadeLoop login password">
            <Input name="password" autoComplete="current-password" type={visible ? "text" : "password"} value={password} disabled={busy || uncertain} onChange={e => setPassword(e.target.value)} required maxLength={256} />
          </Field>
          <Button type="button" variant="ghost" aria-pressed={visible} disabled={busy} onClick={() => setVisible(v => !v)}>{visible ? <EyeOff /> : <Eye />}{visible ? "Hide password" : "Show password"}</Button>
          {message && <p role="alert">{message}</p>}
          {uncertain && <Button type="button" variant="outline" disabled={busy} onClick={async () => { if (lock.current) return; lock.current = true; setBusy(true); try { await checkOutcome(); } finally { lock.current = false; setBusy(false); } }}>Check connection status</Button>}
          <div className="disconnect-actions">
            <Button type="button" variant="outline" disabled={busy} onClick={() => close(false)}>Cancel</Button>
            <Button type="submit" variant="destructive" disabled={busy || uncertain || !password}>{busy ? "Disconnecting and deleting…" : "Disconnect and delete everything"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  </>;
}
