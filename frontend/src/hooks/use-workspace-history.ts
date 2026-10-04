import { useEffect, useRef } from "react";
import type { Page } from "../types";

export interface WorkspaceLocation { page: Page; folder: string }
export function readWorkspaceLocation(): WorkspaceLocation {
  const hash = window.location.hash;
  if (hash.startsWith("#automations/folder/")) {
    try { return { page: "automations", folder: decodeURIComponent(hash.slice(20)) }; } catch { /* Invalid fragments return to the root. */ }
  }
  const page = hash.slice(1);
  return { page: ["create", "dashboard", "contacts", "archive"].includes(page) ? page as Page : "automations", folder: "" };
}
function href(location: WorkspaceLocation) {
  return location.page === "automations" && location.folder ? `#automations/folder/${encodeURIComponent(location.folder)}` : `#${location.page}`;
}
export function useWorkspaceHistory(initial: WorkspaceLocation, canLeave: () => boolean, restore: (location: WorkspaceLocation) => void) {
  const current = useRef({ location: initial, index: typeof history.state?.fadeLoopIndex === "number" ? history.state.fadeLoopIndex : 0 });
  const handlers = useRef({ canLeave, restore });
  handlers.current = { canLeave, restore };
  useEffect(() => {
    history.replaceState({ ...history.state, fadeLoopIndex: current.current.index }, "", href(current.current.location));
    let reverting = false;
    const changed = () => {
      if (window.location.hash === href(current.current.location)) { reverting = false; return; }
      if (reverting) return;
      const next = readWorkspaceLocation();
      const index = typeof history.state?.fadeLoopIndex === "number" ? history.state.fadeLoopIndex : null;
      if (!handlers.current.canLeave()) {
        if (index !== null && index !== current.current.index) {
          reverting = true;
          history.go(current.current.index - index);
        } else history.replaceState({ ...history.state, fadeLoopIndex: current.current.index }, "", href(current.current.location));
        return;
      }
      current.current = { location: next, index: index ?? current.current.index + 1 };
      if (index === null) history.replaceState({ ...history.state, fadeLoopIndex: current.current.index }, "", href(next));
      handlers.current.restore(next);
    };
    window.addEventListener("popstate", changed);
    window.addEventListener("hashchange", changed);
    return () => { window.removeEventListener("popstate", changed); window.removeEventListener("hashchange", changed); };
  }, []);
  return (location: WorkspaceLocation, replace = false) => {
    const target = href(location);
    if (window.location.hash === target) return;
    const index = current.current.index + (replace ? 0 : 1);
    history[replace ? "replaceState" : "pushState"]({ ...history.state, fadeLoopIndex: index }, "", target);
    current.current = { location, index };
  };
}
