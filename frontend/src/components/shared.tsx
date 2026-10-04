import type { ReactNode } from "react";
import {
  LoaderCircle,
  Zap,
  Search,
  CircleAlert,
  RefreshCw,
} from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Badge } from "./ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

export function Brand() {
  return (
    <a className="brand" href="/" aria-label="FadeLoop home">
      <span className="brand-mark">
        <img src="/logo.svg" alt="" width="36" height="36" />
      </span>
      <span className="brand-wordmark">FadeLoop</span>
    </a>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div className="field">
      <label className="field-control">
        <span>{label}</span>
        {children}
      </label>
      {hint && <small>{hint}</small>}
    </div>
  );
}
export function Choice({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  options: { value: string; label: string }[];
  disabled?: boolean;
}) {
  return (
    <Select
      value={value || "__all"}
      onValueChange={(v) => onChange(v === "__all" ? "" : v)}
      disabled={disabled}
    >
      <SelectTrigger aria-label={label} className="choice">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value || "__all"}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
export function SearchField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
}) {
  return (
    <div className="search-field">
      <Search size={19} />
      <Input
        aria-label={label}
        placeholder={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
export function StateBadge({
  active,
  archived,
}: {
  active: boolean;
  archived?: boolean;
}) {
  return (
    <Badge
      variant="secondary"
      className={active ? "state-badge live" : "state-badge"}
    >
      {archived ? "archived" : active ? "live" : "stopped"}
    </Badge>
  );
}
export function PageHeading({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children?: ReactNode;
}) {
  return (
    <header className="page-heading">
      <div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      {children && <div className="heading-actions">{children}</div>}
    </header>
  );
}
export function Empty({
  children,
  icon = <Zap size={43} />,
  className = "",
}: {
  children: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`empty-state ${className}`}>
      <div className="empty-icon">{icon}</div>
      <div>{children}</div>
    </div>
  );
}
export function Loading() {
  return (
    <div role="status" className="loading-state">
      <LoaderCircle className="animate-spin" size={24} />
      Loading your workspace…
    </div>
  );
}
export function Failure({
  message,
  retry,
}: {
  message: string;
  retry?: () => void;
}) {
  return (
    <div role="alert" className="failure-state">
      <CircleAlert size={21} />
      <span>{message}</span>
      {retry && (
        <Button variant="outline" onClick={retry}>
          <RefreshCw />
          Try again
        </Button>
      )}
    </div>
  );
}
export function timeAgo(ts: number) {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(ts * 1000).toLocaleDateString();
}
