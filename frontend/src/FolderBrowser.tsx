import { useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { ContextMenu } from "radix-ui";
import type { AutomationFolder } from "./types";
import type { FolderAction } from "./FolderManager";
import { Button } from "./components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./components/ui/dropdown-menu";

export function FolderIcon() {
  return <svg className="drive-folder-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8z" /></svg>;
}
export function FolderBrowser({ folders, counts, open, action }: {
  folders: AutomationFolder[]; counts: Map<string, number>; open(id: string): void; action(value: FolderAction): void;
}) {
  return <section className="folder-section" aria-label="Folders"><h2>Folders</h2>
    <div className="drive-folders">{folders.map(folder => <FolderTile key={folder.folder_id} folder={folder} count={counts.get(folder.folder_id) || 0} open={open} action={action} />)}</div>
    {!folders.length && <p className="muted">No folders in this location.</p>}
  </section>;
}
function FolderTile({ folder, count, open, action }: {
  folder: AutomationFolder; count: number; open(id: string): void; action(value: FolderAction): void;
}) {
  const [menu, setMenu] = useState(false);
  return <ContextMenu.Root>
    <ContextMenu.Trigger asChild>
      <div className="drive-folder-tile" onKeyDown={event => {
        if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") { event.preventDefault(); setMenu(true); }
      }}>
        <button type="button" className="folder-open" aria-label={`Open folder ${folder.name}`} onClick={() => open(folder.folder_id)}>
          <FolderIcon /><span><strong>{folder.name}</strong><small>{count} {count === 1 ? "automation" : "automations"}</small></span>
        </button>
        <DropdownMenu open={menu} onOpenChange={setMenu}>
          <DropdownMenuTrigger asChild><Button size="icon" variant="ghost" aria-label={`Actions for folder ${folder.name}`}><MoreHorizontal /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => open(folder.folder_id)}>Open</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => action({ kind: "rename", folder })}>Rename</DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onSelect={() => action({ kind: "delete", folder })}>Delete folder</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </ContextMenu.Trigger>
    <ContextMenu.Portal><ContextMenu.Content className="folder-context-menu">
      <ContextMenu.Item onSelect={() => open(folder.folder_id)}>Open</ContextMenu.Item>
      <ContextMenu.Item onSelect={() => action({ kind: "rename", folder })}>Rename</ContextMenu.Item>
      <ContextMenu.Item className="danger-text" onSelect={() => action({ kind: "delete", folder })}>Delete folder</ContextMenu.Item>
    </ContextMenu.Content></ContextMenu.Portal>
  </ContextMenu.Root>;
}
