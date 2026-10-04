import { useEffect, useState } from "react";
import type { AutomationFolder } from "./types";
import { api } from "./lib/api";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Field } from "./components/shared";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./components/ui/dialog";

export type FolderAction = { kind: "create" } | { kind: "rename" | "delete"; folder: AutomationFolder };
export function FolderManager({ action, close, refresh }: { action: FolderAction | null; close(): void; refresh(): void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setName(action && action.kind !== "create" ? action.folder.name : ""); setError(""); }, [action]);
  async function submit() {
    if (!action || busy) return;
    setBusy(true); setError("");
    try {
      const path = action.kind === "create" ? "/api/folders" : `/api/folders/${action.kind}`;
      await api(path, { method: "POST", body: { name, ...(action.kind === "create" ? {} : { folder_id: action.folder.folder_id }) } });
      refresh(); close();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const deleting = action?.kind === "delete";
  return <Dialog open={!!action} onOpenChange={open => { if (!open && !busy) close(); }}>
    <DialogContent className="folder-dialog"><DialogHeader>
      <DialogTitle>{deleting ? "Delete folder" : action?.kind === "rename" ? "Rename folder" : "New folder"}</DialogTitle>
      <DialogDescription>{deleting ? `Delete “${name}”? Its automations will remain in Unfiled.` : "Organize automations without changing how they run."}</DialogDescription>
    </DialogHeader>
    <form onSubmit={e => { e.preventDefault(); void submit(); }}>
      {!deleting && <Field label="Folder name"><Input autoFocus autoComplete="off" maxLength={80} value={name} onChange={e => setName(e.target.value)} disabled={busy} /></Field>}
      {error && <p role="alert">{error}</p>}
      <div className="folder-actions">
        <Button type="button" variant="outline" disabled={busy} onClick={close}>Cancel</Button>
        <Button type="submit" variant={deleting ? "destructive" : "default"} disabled={busy || (!deleting && !name.trim())}>
          {busy ? "Saving…" : deleting ? "Delete folder" : action?.kind === "rename" ? "Save folder name" : "Create folder"}
        </Button>
      </div>
    </form>
    </DialogContent>
  </Dialog>;
}
