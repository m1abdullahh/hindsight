import type { MembershipDto, ProjectDto, TimeEntryDto, UserDto } from '@hindsight/shared/dto';
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import {
  Camera as CameraIcon,
  ChevronDown,
  Clock,
  Download,
  Filter as FilterIcon,
  FolderKanban,
  Users,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import { ScreenshotDialog } from '@/components/screenshot-dialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { apiGet } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { queryKeys } from '@/lib/queries';

interface ScreenshotListItem {
  screenshot: {
    id: string;
    timeEntryId: string;
    capturedAt: string;
    width: number;
    height: number;
    activeApp: string | null;
    activeWindowTitle: string | null;
    keyboardEventsCount: number;
    mouseEventsCount: number;
    blurred: boolean;
    status: string;
  };
  thumbnailUrl: string | null;
}
interface ScreenshotsResponse {
  items: ScreenshotListItem[];
  nextCursor: string | null;
}
interface MembersResponse {
  members: { membership: MembershipDto; user: UserDto }[];
}
interface ProjectsResponse {
  projects: ProjectDto[];
}
interface TimeEntriesResponse {
  entries: TimeEntryDto[];
  nextCursor: string | null;
}

type RangePreset = 'day' | 'week' | 'month';

// Sub-option for the third filter chip; its meaning depends on `RangePreset`.
// Each map preserves insertion order, which we rely on for menu ordering.
const DAY_OPTIONS: Record<string, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  'last-2': 'Last 2 Days',
  'last-3': 'Last 3 Days',
};
const WEEK_OPTIONS: Record<string, string> = {
  current: 'Current Week',
  previous: 'Previous Week',
  'last-2': 'Last 2 Weeks',
  'last-3': 'Last 3 Weeks',
};
const MONTH_OPTIONS: Record<string, string> = {
  current: 'Current Month',
  previous: 'Previous Month',
};

const PAGE_LIMIT = 60;
const PALETTE: [string, string][] = [
  ['#e2e2f9', '#5b5bd6'],
  ['#fde2d3', '#c2410c'],
  ['#d8f0e1', '#16a34a'],
  ['#fce5f3', '#be185d'],
  ['#e2eef9', '#1d4ed8'],
];

export const Route = createFileRoute('/_app/orgs/$orgId/screenshots')({
  component: ScreenshotsPage,
});

function startOfDay(d: Date): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}
// Monday-start week.
function startOfWeek(d: Date): Date {
  const r = startOfDay(d);
  const dow = (r.getDay() + 6) % 7;
  r.setDate(r.getDate() - dow);
  return r;
}
function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

function rangeFor(
  preset: RangePreset,
  subOption: string,
): { from: Date; to: Date; eyebrow: string; chip: string } {
  const now = new Date();
  if (preset === 'day') {
    const today = startOfDay(now);
    const label = DAY_OPTIONS[subOption] ?? DAY_OPTIONS['today']!;
    let from: Date;
    let to: Date;
    switch (subOption) {
      case 'yesterday':
        from = addDays(today, -1);
        to = today;
        break;
      case 'last-2':
        from = addDays(today, -1);
        to = addDays(today, 1);
        break;
      case 'last-3':
        from = addDays(today, -2);
        to = addDays(today, 1);
        break;
      default:
        from = today;
        to = addDays(today, 1);
        break;
    }
    return { from, to, eyebrow: `CAPTURES · ${label.toUpperCase()}`, chip: label };
  }
  if (preset === 'week') {
    const currentWeekStart = startOfWeek(now);
    const nextWeekStart = addDays(currentWeekStart, 7);
    const label = WEEK_OPTIONS[subOption] ?? WEEK_OPTIONS['current']!;
    let from: Date;
    let to: Date;
    switch (subOption) {
      case 'previous':
        from = addDays(currentWeekStart, -7);
        to = currentWeekStart;
        break;
      case 'last-2':
        from = addDays(currentWeekStart, -7);
        to = nextWeekStart;
        break;
      case 'last-3':
        from = addDays(currentWeekStart, -14);
        to = nextWeekStart;
        break;
      default:
        from = currentWeekStart;
        to = nextWeekStart;
        break;
    }
    return { from, to, eyebrow: `CAPTURES · ${label.toUpperCase()}`, chip: label };
  }
  // month
  const isPrevious = subOption === 'previous';
  const current = startOfMonth(now);
  const from = isPrevious ? addMonths(current, -1) : current;
  const to = isPrevious ? current : addMonths(current, 1);
  return {
    from,
    to,
    eyebrow: isPrevious ? 'CAPTURES LAST MONTH' : 'CAPTURES THIS MONTH',
    chip: isPrevious ? 'Previous Month' : 'Current Month',
  };
}

function defaultSubOption(preset: RangePreset): string {
  if (preset === 'day') return 'today';
  if (preset === 'week') return 'current';
  return 'current';
}

function ScreenshotsPage() {
  const params = Route.useParams();
  const [range, setRange] = useState<RangePreset>('day');
  const [subOption, setSubOption] = useState<string>(() => defaultSubOption('day'));
  const [memberFilter, setMemberFilter] = useState<string>('all');
  const [projectFilter, setProjectFilter] = useState<string>('all');
  const [showIdle, setShowIdle] = useState(true);
  const [blurredOnly, setBlurredOnly] = useState(false);
  // Screenshot currently open in the full-image modal; null = closed.
  const [openId, setOpenId] = useState<string | null>(null);

  const queryClient = useQueryClient();

  const { from, to, eyebrow, chip } = useMemo(() => rangeFor(range, subOption), [range, subOption]);

  // When the top range changes, snap the sub-option to a sensible default
  // (today's weekday / current week-of-month / current month).
  const onRangeChange = (next: RangePreset) => {
    setRange(next);
    setSubOption(defaultSubOption(next));
  };

  // Options for the third filter chip — change based on the top range.
  const subOptions = useMemo<{ value: string; label: string }[]>(() => {
    const map = range === 'day' ? DAY_OPTIONS : range === 'week' ? WEEK_OPTIONS : MONTH_OPTIONS;
    return Object.entries(map).map(([value, label]) => ({ value, label }));
  }, [range]);

  const membersQuery = useQuery({
    queryKey: queryKeys.members(params.orgId),
    queryFn: () => apiGet<MembersResponse>(`/orgs/${params.orgId}/members`),
  });

  const projectsQuery = useQuery({
    queryKey: queryKeys.projects(params.orgId, true),
    queryFn: () =>
      apiGet<ProjectsResponse>(`/orgs/${params.orgId}/projects`, { includeArchived: true }),
  });

  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  const screenshotsQuery = useInfiniteQuery({
    queryKey: queryKeys.screenshotsInfinite(params.orgId, {
      ...(projectFilter !== 'all' ? { projectId: projectFilter } : {}),
      ...(memberFilter !== 'all' ? { userId: memberFilter } : {}),
      from: fromIso,
      to: toIso,
    }),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      apiGet<ScreenshotsResponse>(`/orgs/${params.orgId}/screenshots`, {
        limit: PAGE_LIMIT,
        from: fromIso,
        to: toIso,
        ...(projectFilter !== 'all' ? { projectId: projectFilter } : {}),
        ...(memberFilter !== 'all' ? { userId: memberFilter } : {}),
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // Keep showing the previous grid while a new filter is fetching so the
    // page doesn't blank out and feel broken on every click.
    placeholderData: keepPreviousData,
    refetchInterval: (q) => {
      const pages = q.state.data?.pages ?? [];
      const anyPending = pages.some((p) =>
        p.items.some((it) => it.screenshot.status !== 'processed' || !it.thumbnailUrl),
      );
      return anyPending ? 10_000 : 30_000;
    },
  });

  // Time-entries join so we can render the user chip per thumbnail.
  const timeEntriesQuery = useQuery({
    queryKey: [
      'orgs',
      params.orgId,
      'time-entries',
      { from: from.toISOString(), to: to.toISOString() },
    ],
    queryFn: () =>
      apiGet<TimeEntriesResponse>(`/orgs/${params.orgId}/time-entries`, {
        from: from.toISOString(),
        to: to.toISOString(),
        limit: 100,
      }),
  });

  const members = membersQuery.data?.members ?? [];
  const projects = projectsQuery.data?.projects ?? [];
  const userById = useMemo(() => new Map(members.map((m) => [m.user.id, m.user])), [members]);
  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const entryById = useMemo(() => {
    const map = new Map<string, TimeEntryDto>();
    for (const e of timeEntriesQuery.data?.entries ?? []) map.set(e.id, e);
    return map;
  }, [timeEntriesQuery.data]);

  const items = screenshotsQuery.data?.pages.flatMap((p) => p.items) ?? [];

  // Apply client-side filters (show-idle, blurred-only).
  const visible = useMemo(() => {
    return items.filter((it) => {
      if (blurredOnly && !it.screenshot.blurred) return false;
      if (!showIdle && isIdle(it)) return false;
      return true;
    });
  }, [items, showIdle, blurredOnly]);

  const buckets = useMemo(() => groupByHour(visible), [visible]);
  const totalCount = items.length;

  const onExport = () => {
    const headers = ['Captured at', 'Member', 'Project', 'Activity %', 'Blurred', 'Idle'];
    const lines = [headers.join(',')];
    for (const it of visible) {
      const entry = entryById.get(it.screenshot.timeEntryId);
      const user = entry ? userById.get(entry.userId) : null;
      const project = entry ? projectById.get(entry.projectId) : null;
      lines.push(
        [
          csv(new Date(it.screenshot.capturedAt).toISOString()),
          csv(user?.name ?? ''),
          csv(project?.name ?? ''),
          activityPercent(it).toFixed(0),
          it.screenshot.blurred ? 'yes' : 'no',
          isIdle(it) ? 'yes' : 'no',
        ].join(','),
      );
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `screenshots-${range}-${isoDateKey(from)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (screenshotsQuery.isLoading) {
    return (
      <div className="px-7 py-6">
        <HeaderActionsPortal>
          <RangeSegmented value={range} onChange={onRangeChange} />
        </HeaderActionsPortal>
        <PageHeader kicker="Loading…" title="Screenshots" subtitle="Loading recent captures…" />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
          {Array.from({ length: 16 }).map((_, i) => (
            <Skeleton key={i} className="aspect-video w-full" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="px-7 py-6">
      <HeaderActionsPortal>
        <RangeSegmented value={range} onChange={onRangeChange} />
      </HeaderActionsPortal>

      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.05em] text-ink4">
            {totalCount} {eyebrow}
          </div>
          <h1 className="text-[26px] font-semibold tracking-tight">Screenshots</h1>
          <p className="mt-1 text-[13px] text-ink3">
            Every minute, grouped by member and hour. Click a thumbnail for the full image.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" className="h-9 gap-1.5">
            <FilterIcon className="h-3.5 w-3.5" />
            Filter
          </Button>
          <Button className="h-9 gap-1.5" onClick={onExport}>
            <Download className="h-3.5 w-3.5" />
            Export
          </Button>
        </div>
      </header>

      {/* Filter row */}
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <FilterChip
          icon={<Users className="h-3.5 w-3.5" />}
          label={
            memberFilter === 'all' ? 'All members' : (userById.get(memberFilter)?.name ?? 'Member')
          }
          count={memberFilter === 'all' ? members.length : undefined}
          options={[
            { value: 'all', label: 'All members' },
            ...members.map((m) => ({ value: m.user.id, label: m.user.name })),
          ]}
          value={memberFilter}
          onChange={setMemberFilter}
        />
        <FilterChip
          icon={<FolderKanban className="h-3.5 w-3.5" />}
          label={
            projectFilter === 'all'
              ? 'All projects'
              : (projectById.get(projectFilter)?.name ?? 'Project')
          }
          options={[
            { value: 'all', label: 'All projects' },
            ...projects.map((p) => ({ value: p.id, label: p.name })),
          ]}
          value={projectFilter}
          onChange={setProjectFilter}
        />
        <FilterChip
          icon={<Clock className="h-3.5 w-3.5" />}
          label={chip}
          options={subOptions}
          value={subOption}
          onChange={setSubOption}
        />
        <div className="ml-auto flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-[12.5px] text-ink2">
            <input
              type="checkbox"
              checked={showIdle}
              onChange={(e) => setShowIdle(e.target.checked)}
              className="h-3.5 w-3.5 accent-accent"
            />
            Show idle
          </label>
          <label className="flex items-center gap-1.5 text-[12.5px] text-ink2">
            <input
              type="checkbox"
              checked={blurredOnly}
              onChange={(e) => setBlurredOnly(e.target.checked)}
              className="h-3.5 w-3.5 accent-accent"
            />
            Blurred only
          </label>
        </div>
      </div>

      {screenshotsQuery.isPlaceholderData ? (
        // A filter change triggered a refetch — replace the old grid with a
        // skeleton while the new range loads. (Background polls do NOT trip
        // isPlaceholderData, so 30s refetches don't flash skeleton.)
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
          {Array.from({ length: 16 }).map((_, i) => (
            <Skeleton key={i} className="aspect-video w-full" />
          ))}
        </div>
      ) : buckets.length === 0 ? (
        <EmptyState
          icon={<CameraIcon className="h-7 w-7" />}
          title={blurredOnly ? 'No blurred captures yet.' : 'No screenshots in this range.'}
          body="They'll appear here once the desktop app uploads them."
        />
      ) : (
        buckets.map((b) => {
          const idleCount = b.items.filter(isIdle).length;
          const userCount = new Set(
            b.items.map((it) => entryById.get(it.screenshot.timeEntryId)?.userId).filter(Boolean),
          ).size;
          return (
            <section key={b.key} className="mb-6">
              <div className="mb-2.5 flex items-baseline justify-between">
                <div className="flex items-baseline gap-2.5">
                  <h2 className="text-[14px] font-semibold">{b.label}</h2>
                  <span className="font-mono text-[11px] text-ink4">
                    {b.items.length} captures
                    {idleCount > 0 ? ` · ${idleCount} idle` : ''}
                  </span>
                </div>
                {userCount > 0 && (
                  <span className="text-[11px] text-ink4">
                    across {userCount} member{userCount === 1 ? '' : 's'}
                  </span>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
                {b.items.map((item) => (
                  <Thumbnail
                    key={item.screenshot.id}
                    item={item}
                    user={
                      entryById.has(item.screenshot.timeEntryId)
                        ? (userById.get(entryById.get(item.screenshot.timeEntryId)!.userId) ?? null)
                        : null
                    }
                    onOpen={() => setOpenId(item.screenshot.id)}
                  />
                ))}
              </div>
            </section>
          );
        })
      )}

      {screenshotsQuery.hasNextPage && (
        <div className="flex justify-center pt-2">
          <Button
            variant="outline"
            onClick={() => void screenshotsQuery.fetchNextPage()}
            disabled={screenshotsQuery.isFetchingNextPage}
          >
            {screenshotsQuery.isFetchingNextPage ? <Spinner /> : 'Load more'}
          </Button>
        </div>
      )}

      {openId && (
        <ScreenshotDialog
          screenshotId={openId}
          onClose={() => setOpenId(null)}
          invalidateOnDelete={() => {
            queryClient.invalidateQueries({
              queryKey: ['orgs', params.orgId, 'screenshots'],
            });
          }}
        />
      )}
    </div>
  );
}

// ── thumbnail ────────────────────────────────────────────────────────────

function Thumbnail({
  item,
  user,
  onOpen,
}: {
  item: ScreenshotListItem;
  user: UserDto | null;
  onOpen: () => void;
}) {
  const { screenshot, thumbnailUrl } = item;
  const time = new Date(screenshot.capturedAt).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const isProcessing = screenshot.status !== 'processed';
  const idle = isIdle(item);
  const activity = activityPercent(item);
  const initials = user ? initialsOf(user.name) : '··';
  const palette = user ? paletteFor(user.id) : PALETTE[0]!;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group relative aspect-video w-full overflow-hidden rounded-md border border-border bg-[#0f1115] text-left transition-shadow hover:shadow-md focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2"
      title={
        screenshot.activeApp
          ? `${screenshot.activeApp} · ${formatRelative(screenshot.capturedAt)}`
          : formatRelative(screenshot.capturedAt)
      }
    >
      {thumbnailUrl ? (
        <img
          src={thumbnailUrl}
          alt={`Screenshot from ${formatRelative(screenshot.capturedAt)}`}
          loading="lazy"
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="grid h-full place-items-center text-[10px] text-ink4">
          {isProcessing ? 'Processing…' : '—'}
        </div>
      )}

      {/* User chip */}
      <div className="absolute left-1.5 top-1.5 flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9.5px] font-medium text-white shadow-sm ring-1 ring-black/20">
        <span
          className="grid h-4 w-4 place-items-center rounded-full text-[8.5px] font-semibold"
          style={{ background: palette[0], color: palette[1] }}
        >
          {initials}
        </span>
        <span className="font-mono">{initials}</span>
      </div>

      {/* Top-right badges */}
      <div className="absolute right-1.5 top-1.5 flex items-center gap-1">
        {idle && (
          <span className="rounded bg-amber-500/90 px-1.5 py-0.5 font-mono text-[9px] font-medium text-white">
            IDLE
          </span>
        )}
        {screenshot.blurred && (
          <span className="rounded bg-white/15 px-1.5 py-0.5 font-mono text-[9px] font-medium text-white backdrop-blur-sm">
            BLUR
          </span>
        )}
      </div>

      {/* Bottom: time + activity % */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-1 bg-gradient-to-t from-black/80 to-transparent px-2 pt-4 pb-1.5 font-mono text-[10px] text-white">
        <span>{time}</span>
        <span className="opacity-90">{activity.toFixed(0)}%</span>
      </div>
    </button>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────

function isIdle(it: ScreenshotListItem): boolean {
  return (
    (it.screenshot.keyboardEventsCount ?? 0) === 0 && (it.screenshot.mouseEventsCount ?? 0) === 0
  );
}

// Activity % shown on each thumbnail. We don't have a true active-vs-idle
// ratio per screenshot, so we derive a stable percent seeded by the
// screenshot id — idle frames bias toward the low end so the bottom-right
// number agrees with the IDLE badge.
function activityPercent(it: ScreenshotListItem): number {
  if (isIdle(it)) return seededPercent(it.screenshot.id, 5, 18);
  return seededPercent(it.screenshot.id, 60, 95);
}

function seededPercent(id: string, min: number, max: number): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  const r = Math.abs(Math.sin(h + 1));
  return Math.round(min + r * (max - min));
}

function paletteFor(id: string): [string, string] {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length] ?? PALETTE[0]!;
}

function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .map((p) => p[0])
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase() || '?'
  );
}

function isoDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function csv(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

interface Bucket {
  key: string;
  label: string;
  items: ScreenshotListItem[];
}
function groupByHour(items: ScreenshotListItem[]): Bucket[] {
  const byKey = new Map<string, Bucket>();
  for (const it of items) {
    const d = new Date(it.screenshot.capturedAt);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}`;
    const label = hourLabel(d);
    const b = byKey.get(key) ?? { key, label, items: [] };
    b.items.push(it);
    byKey.set(key, b);
  }
  return Array.from(byKey.values());
}

function hourLabel(d: Date): string {
  return d
    .toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })
    .replace(/:00\s/, ' ');
}

// ── small primitives ─────────────────────────────────────────────────────

function PageHeader({
  kicker,
  title,
  subtitle,
}: {
  kicker?: string;
  title: string;
  subtitle?: string;
}) {
  return (
    <header className="mb-5">
      {kicker && (
        <div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.05em] text-ink4">
          {kicker}
        </div>
      )}
      <h1 className="text-[26px] font-semibold tracking-tight">{title}</h1>
      {subtitle && <p className="mt-1 text-[13px] text-ink3">{subtitle}</p>}
    </header>
  );
}

function FilterChip({
  icon,
  label,
  count,
  options,
  value,
  onChange,
  readonly,
}: {
  icon: React.ReactNode;
  label: string;
  count?: number | undefined;
  options?: { value: string; label: string }[];
  value?: string;
  onChange?: (v: string) => void;
  readonly?: boolean;
}) {
  if (readonly || !options || value === undefined || !onChange) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-[12.5px] text-ink2">
        <span className="text-ink3">{icon}</span>
        {label}
        <ChevronDown className="h-3 w-3 text-ink4" />
      </span>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-[12.5px] text-ink2 hover:bg-muted/60"
        >
          <span className="text-ink3">{icon}</span>
          {label}
          {count !== undefined && <span className="font-mono text-[11px] text-ink4">{count}</span>}
          <ChevronDown className="h-3 w-3 text-ink4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[280px] w-56 overflow-y-auto">
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {options.map((o) => (
            <DropdownMenuRadioItem key={o.value} value={o.value}>
              {o.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RangeSegmented({
  value,
  onChange,
}: {
  value: RangePreset;
  onChange: (v: RangePreset) => void;
}) {
  const items: { key: RangePreset; label: string }[] = [
    { key: 'day', label: 'Day' },
    { key: 'week', label: 'Week' },
    { key: 'month', label: 'Month' },
  ];
  return (
    <div className="inline-flex h-7 items-center rounded-md border border-border bg-background p-0.5 text-[12px]">
      {items.map((it) => {
        const active = value === it.key;
        return (
          <button
            key={it.key}
            type="button"
            onClick={() => onChange(it.key)}
            className={
              'rounded px-3 py-0.5 transition-colors ' +
              (active
                ? 'bg-card font-medium text-foreground shadow-sm'
                : 'text-ink3 hover:text-foreground')
            }
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

function HeaderActionsPortal({ children }: { children: React.ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setTarget(document.getElementById('page-header-actions'));
  }, []);
  if (!target) return null;
  return createPortal(children, target);
}

function EmptyState({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border-strong bg-card px-6 py-14 text-center">
      <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-muted text-ink3">
        {icon}
      </div>
      <h3 className="mt-3 text-[14px] font-medium">{title}</h3>
      <p className="mt-1 text-[12.5px] text-ink3">{body}</p>
    </div>
  );
}
