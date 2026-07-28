"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Activity,
  Braces,
  Building2,
  ChevronDown,
  CircleDot,
  Clock,
  KeyRound,
  MessageSquare,
  PlayCircle,
  Radio,
  Rocket,
  Search,
  Settings2,
  Shapes,
  Shield,
  ScrollText,
  Tag,
  Terminal,
  User,
  Users,
  FolderKanban,
  X,
} from "lucide-react";
import type { ActivityLog } from "@/lib/types";
import {
  ACTOR_LABELS,
  ACTOR_OPTIONS,
  CATEGORY_LABELS,
  CATEGORY_OPTIONS,
  CHANNEL_LABELS,
  CHANNEL_OPTIONS,
  STATUS_OPTIONS,
} from "@/lib/logs";
import { cn, timeAgo } from "@/lib/utils";
import { Badge, Input, Select } from "@/components/ui";

interface Filters {
  q: string;
  channel: string;
  category: string;
  status: string;
  actor: string;
  project: string;
  days: string;
}

interface Props {
  rows: ActivityLog[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  projectNames: Record<string, string>;
  filters: Filters;
}

type Tone = "neutral" | "terracotta" | "mint" | "teal" | "butter" | "sand";

const STATUS_TONE: Record<string, Tone> = {
  success: "mint",
  failure: "terracotta",
  info: "teal",
  pending: "butter",
};

const CHANNEL_TONE: Record<string, Tone> = {
  dashboard: "neutral",
  api: "teal",
  mcp: "butter",
  cli: "sand",
  cron: "mint",
  system: "neutral",
};

const CATEGORY_ICON: Record<string, typeof Activity> = {
  run: PlayCircle,
  auth: Shield,
  oauth: Shield,
  project: FolderKanban,
  prompt: MessageSquare,
  topic: Tag,
  competitor: Users,
  provider_key: KeyRound,
  api_key: KeyRound,
  onboarding: Rocket,
  settings: Settings2,
  mcp_tool: Terminal,
  system: Activity,
};

const DAYS_OPTIONS: [string, string][] = [
  ["", "All time"],
  ["1", "Last 24 hours"],
  ["7", "Last 7 days"],
  ["30", "Last 30 days"],
];

export function LogsExplorer({
  rows,
  total,
  page,
  pageSize,
  pageCount,
  projectNames,
  filters,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [q, setQ] = useState(filters.q);

  // Push a partial filter change into the URL; the server page re-renders with
  // the new result set. Any change but paging resets to page 1.
  const update = useCallback(
    (changes: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [k, v] of Object.entries(changes)) {
        if (v === null || v === "") params.delete(k);
        else params.set(k, v);
      }
      if (!("page" in changes)) params.delete("page");
      const qs = params.toString();
      router.push(qs ? `${pathname}?${qs}` : pathname);
    },
    [router, pathname, searchParams],
  );

  // Keep the search box in sync when the URL changes from elsewhere (Clear, back).
  useEffect(() => {
    setQ(filters.q);
  }, [filters.q]);

  // Debounce free-text search into the URL.
  useEffect(() => {
    const handle = setTimeout(() => {
      if (q !== filters.q) update({ q: q || null });
    }, 400);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const activeCount = [
    filters.channel,
    filters.category,
    filters.status,
    filters.actor,
    filters.project,
    filters.days,
    filters.q,
  ].filter(Boolean).length;

  const projectOptions: [string, string][] = Object.entries(projectNames);

  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <div>
      {/* ---- filter bar ---- */}
      <div className="flex flex-col gap-3 border-b border-ink/10 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search actions, summaries, paths, actors…"
              className="pl-9"
              aria-label="Search logs"
            />
          </div>
          {activeCount > 0 && (
            <button
              type="button"
              onClick={() => {
                setQ("");
                router.push(pathname);
              }}
              className="inline-flex items-center gap-1.5 rounded-xl border border-ink/15 px-3 py-2 text-sm text-ink-soft transition hover:bg-ink/[0.03]"
            >
              <X className="h-3.5 w-3.5" /> Clear
            </button>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <FilterSelect
            label="Channel"
            icon={Radio}
            value={filters.channel}
            onChange={(v) => update({ channel: v })}
            options={CHANNEL_OPTIONS}
          />
          <FilterSelect
            label="Category"
            icon={Shapes}
            value={filters.category}
            onChange={(v) => update({ category: v })}
            options={CATEGORY_OPTIONS}
          />
          <FilterSelect
            label="Actor"
            icon={User}
            value={filters.actor}
            onChange={(v) => update({ actor: v })}
            options={ACTOR_OPTIONS}
          />
          <FilterSelect
            label="Status"
            icon={CircleDot}
            value={filters.status}
            onChange={(v) => update({ status: v })}
            options={STATUS_OPTIONS}
          />
          <FilterSelect
            label="Organization"
            icon={Building2}
            value={filters.project}
            onChange={(v) => update({ project: v })}
            options={projectOptions}
            disabled={projectOptions.length === 0}
          />
          <FilterSelect
            label="Timeframe"
            icon={Clock}
            value={filters.days}
            onChange={(v) => update({ days: v })}
            options={DAYS_OPTIONS}
            includeAll={false}
          />
        </div>
      </div>

      {/* ---- results ---- */}
      {rows.length === 0 ? (
        <div className="px-6 py-16 text-center">
          <ScrollText className="mx-auto mb-3 h-7 w-7 text-ink-faint" />
          <p className="text-sm font-medium text-ink">No events match these filters</p>
          <p className="mt-1 text-sm text-ink-faint">Try widening the timeframe or clearing filters.</p>
        </div>
      ) : (
        <ul className="divide-y divide-ink/[0.06]">
          {rows.map((row) => (
            <LogRow
              key={row.id}
              row={row}
              projectName={row.project_id ? projectNames[row.project_id] ?? null : null}
              open={expanded === row.id}
              onToggle={() => setExpanded((cur) => (cur === row.id ? null : row.id))}
            />
          ))}
        </ul>
      )}

      {/* ---- pagination ---- */}
      {total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-ink/10 p-4">
          <p className="text-xs text-ink-faint">
            Showing <span className="font-medium text-ink-soft">{from.toLocaleString()}</span>–
            <span className="font-medium text-ink-soft">{to.toLocaleString()}</span> of{" "}
            <span className="font-medium text-ink-soft">{total.toLocaleString()}</span>
          </p>
          <div className="flex items-center gap-2">
            <PageButton
              disabled={page <= 1}
              onClick={() => update({ page: String(page - 1) })}
            >
              Previous
            </PageButton>
            <span className="text-xs text-ink-faint">
              Page {page} of {pageCount}
            </span>
            <PageButton
              disabled={page >= pageCount}
              onClick={() => update({ page: String(page + 1) })}
            >
              Next
            </PageButton>
          </div>
        </div>
      )}
    </div>
  );
}

function FilterSelect({
  label,
  icon: Icon,
  value,
  onChange,
  options,
  includeAll = true,
  disabled = false,
}: {
  label: string;
  icon: typeof Activity;
  value: string;
  onChange: (value: string) => void;
  options: [string, string][];
  includeAll?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="relative">
      <Icon
        className={cn(
          "pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2",
          value ? "text-terracotta" : "text-ink-faint",
        )}
      />
      <Select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        disabled={disabled}
        className={cn(
          "h-10 w-full py-0 pl-9 text-sm leading-normal",
          value && "border-terracotta/40",
        )}
      >
        {includeAll && <option value="">{`All ${label.toLowerCase()}`}</option>}
        {options.map(([v, l]) => (
          <option key={v || "_all"} value={v}>
            {l}
          </option>
        ))}
      </Select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
    </div>
  );
}

function PageButton({
  disabled,
  onClick,
  children,
}: {
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-9 items-center rounded-lg border border-ink/15 px-3 text-sm text-ink-soft transition hover:bg-ink/[0.03] disabled:opacity-40 disabled:pointer-events-none"
    >
      {children}
    </button>
  );
}

function LogRow({
  row,
  projectName,
  open,
  onToggle,
}: {
  row: ActivityLog;
  projectName: string | null;
  open: boolean;
  onToggle: () => void;
}) {
  const Icon = CATEGORY_ICON[row.category] ?? Activity;
  const statusTone = STATUS_TONE[row.status] ?? "neutral";
  const hasMeta = row.metadata && Object.keys(row.metadata).length > 0;

  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-start gap-3 px-4 py-3 text-left transition hover:bg-ink/[0.02]"
      >
        <span
          className={cn(
            "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
            row.status === "failure" ? "bg-terracotta/10 text-terracotta-dark" : "bg-ink/[0.05] text-ink-soft",
          )}
        >
          <Icon className="h-4 w-4" />
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium text-ink">{row.summary}</span>
            {row.status !== "success" && (
              <Badge tone={statusTone}>{row.status}</Badge>
            )}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-faint">
            <Badge tone={CHANNEL_TONE[row.channel] ?? "neutral"}>
              {CHANNEL_LABELS[row.channel] ?? row.channel}
            </Badge>
            <span className="text-ink-soft">{row.actor_label ?? ACTOR_LABELS[row.actor_type] ?? row.actor_type}</span>
            <span aria-hidden>·</span>
            <span className="font-mono text-[0.7rem]">{row.action}</span>
            {row.method && row.path && (
              <>
                <span aria-hidden>·</span>
                <span className="font-mono text-[0.7rem]">
                  {row.method} {row.path}
                  {typeof row.status_code === "number" ? ` → ${row.status_code}` : ""}
                </span>
              </>
            )}
            {projectName && (
              <>
                <span aria-hidden>·</span>
                <span>{projectName}</span>
              </>
            )}
          </span>
        </span>

        <span className="flex shrink-0 items-center gap-2">
          <Timestamp iso={row.created_at} />
          <ChevronDown
            className={cn("h-4 w-4 text-ink-faint transition-transform", open && "rotate-180")}
          />
        </span>
      </button>

      {open && (
        <div className="border-t border-ink/[0.06] bg-paper-shade/40 px-4 py-4 pl-[3.75rem]">
          <dl className="grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2">
            <Detail label="Action" value={row.action} mono />
            <Detail label="Category" value={CATEGORY_LABELS[row.category] ?? row.category} />
            <Detail
              label="Actor"
              value={`${row.actor_label ?? ""}${row.actor_label ? " · " : ""}${ACTOR_LABELS[row.actor_type] ?? row.actor_type}`}
            />
            {row.actor_id && <Detail label="Actor id" value={row.actor_id} mono />}
            {(row.target_type || row.target_id) && (
              <Detail
                label="Target"
                value={`${row.target_type ?? ""}${row.target_type && row.target_id ? " · " : ""}${row.target_id ?? ""}`}
                mono
              />
            )}
            {row.method && <Detail label="Request" value={`${row.method} ${row.path ?? ""}`} mono />}
            {typeof row.status_code === "number" && (
              <Detail label="Status code" value={String(row.status_code)} mono />
            )}
            {typeof row.duration_ms === "number" && (
              <Detail label="Duration" value={`${row.duration_ms.toLocaleString()} ms`} />
            )}
            {row.ip && <Detail label="IP" value={row.ip} mono />}
            {row.user_agent && <Detail label="User agent" value={row.user_agent} mono />}
            {projectName && <Detail label="Organization" value={projectName} />}
            <Detail label="When" value={new Date(row.created_at).toLocaleString()} />
          </dl>
          {hasMeta && (
            <div className="mt-3">
              <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-ink-soft">
                <Braces className="h-3 w-3" /> Metadata
              </p>
              <pre className="overflow-x-auto rounded-lg border border-ink/10 bg-surface p-3 text-xs text-ink-soft">
                {JSON.stringify(row.metadata, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col">
      <dt className="text-[0.7rem] uppercase tracking-wide text-ink-faint">{label}</dt>
      <dd className={cn("break-words text-sm text-ink-soft", mono && "font-mono text-xs")}>
        {value}
      </dd>
    </div>
  );
}

// Deterministic on the server (UTC), relative after mount — avoids a hydration
// mismatch while still showing "3m ago" once interactive.
function Timestamp({ iso }: { iso: string }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const display = mounted ? timeAgo(iso) : new Date(iso).toISOString().slice(0, 16).replace("T", " ") + "Z";
  return (
    <time
      dateTime={iso}
      title={mounted ? new Date(iso).toLocaleString() : undefined}
      className="whitespace-nowrap text-xs text-ink-faint"
    >
      {display}
    </time>
  );
}
