import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import type { Session } from "./types";
import { api } from "./lib/api";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Field } from "./components/shared";

export function PasswordSettings({ changed }: { changed(session: Session): void }) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  async function submit() {
    if (busy) return;
    setMessage(""); setError(false);
    try {
      if ([...password].length < 8 || [...password].length > 128) throw new Error("Password must contain 8–128 characters.");
      if (password !== confirmation) throw new Error("Passwords do not match.");
      setBusy(true);
      const session = await api<Session>("/session/password", { method: "POST", body: { new_password: password } });
      changed(session);
      setMessage("Password changed. You remain signed in; other devices have been signed out.");
    } catch (e) { setMessage((e as Error).message); setError(true); }
    finally { setPassword(""); setConfirmation(""); setVisible(false); setBusy(false); }
  }
  return <form className="password-settings" onSubmit={e => { e.preventDefault(); void submit(); }}>
    <h3>Change password</h3>
    <p className="muted">Set a new password using your signed-in account.</p>
    <Field label="New password" hint="8–128 characters. Spaces are allowed.">
      <Input name="new-password" type={visible ? "text" : "password"} autoComplete="new-password" value={password} disabled={busy} onChange={e => setPassword(e.target.value)} />
    </Field>
    <Field label="Confirm new password">
      <Input name="confirm-password" type={visible ? "text" : "password"} autoComplete="new-password" value={confirmation} disabled={busy} onChange={e => setConfirmation(e.target.value)} />
    </Field>
    <div className="folder-actions">
      <Button type="button" variant="ghost" disabled={busy} aria-pressed={visible} onClick={() => setVisible(v => !v)}>{visible ? <EyeOff /> : <Eye />}{visible ? "Hide passwords" : "Show passwords"}</Button>
      <Button type="submit" disabled={busy || !password || !confirmation}>{busy ? "Changing password…" : "Change password"}</Button>
    </div>
    {message && <p role={error ? "alert" : "status"}>{message}</p>}
  </form>;
}
