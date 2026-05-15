import type { MembershipDto, ProjectDto, TimeEntryDto, UserDto } from '@hindsight/shared/dto';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import {
  Bookmark,
  Calendar,
  ChevronDown,
  FileSpreadsheet,
  FileText,
  Search,
  Share2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { AvatarLive } from '@/components/ui/avatar-live';
import { Skeleton } from '@/components/ui/skeleton';
import { apiGet } from '@/lib/api';
import { formatHours } from '@/lib/format';
import { formatMoney } from '@/lib/money';
import { projectAccent } from '@/lib/project-accent';
import { queryKeys } from '@/lib/queries';

// ── types ────────────────────────────────────────────────────────────────

interface TimeTotalRow {
  userId: string;
  userName: string;
  userEmail: string;
  projectId: string;
  projectName: string;
  totalActiveSeconds: number;
  hourlyRateCents: number | null;
  earnedCents: number | null;
}
interface TimeTotalsResponse {
  rows: TimeTotalRow[];
  range: { from: string | null; to: string | null };
}
interface TimeTotalByDaySegment {
  projectId: string;
  projectName: string;
  totalActiveSeconds: number;
}
interface TimeTotalByDayRow {
  index: number;
  totalActiveSeconds: number;
  segments: TimeTotalByDaySegment[];
}
interface TimeTotalsByDayResponse {
  days: TimeTotalByDayRow[];
  range: { from: string; to: string };
}
interface MemberRow {
  membership: MembershipDto;
  user: UserDto;
}
interface MembersResponse {
  members: MemberRow[];
}
interface ProjectsResponse {
  projects: ProjectDto[];
}
interface TimeEntriesResponse {
  entries: TimeEntryDto[];
  nextCursor: string | null;
}

type Preset =
  | 'today'
  | 'yesterday'
  | 'thisWeek'
  | 'lastWeek'
  | 'thisMonth'
  | 'lastMonth'
  | 'thisYear'
  | 'lastYear'
  | 'custom';

type ReportType =
  | 'summary-by-project'
  | 'summary-by-employee'
  | 'daily-by-employee'
  | 'detailed'
  | 'apps-urls';

type SubTab = 'timeline' | 'employees' | 'projects' | 'notes' | 'apps-urls';

interface AppliedFilters {
  preset: Preset;
  from: Date;
  to: Date;
  employeeIds: string[];
  projectIds: string[];
  noteContains: string;
  excludeArchived: boolean;
  onlyOffline: boolean;
  reportType: ReportType;
}

// ── route ────────────────────────────────────────────────────────────────

export const Route = createFileRoute('/_app/orgs/$orgId/report')({
  component: ReportPage,
});

// ── date helpers ─────────────────────────────────────────────────────────

const MONTH_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function startOfDay(d: Date): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}
function startOfWeek(d: Date): Date {
  const r = startOfDay(d);
  const day = r.getDay();
  const diff = day === 0 ? 6 : day - 1; // Monday-first
  r.setDate(r.getDate() - diff);
  return r;
}
function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function startOfYear(d: Date): Date {
  return new Date(d.getFullYear(), 0, 1);
}
function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}
function addYears(d: Date, n: number): Date {
  return new Date(d.getFullYear() + n, 0, 1);
}
function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function shortDate(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  return `${dd}/${mm}/${yy}`;
}
function diffDays(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86_400_000);
}
function timezoneLabel(): string {
  const offsetMin = -new Date().getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return m === 0 ? `UTC${sign}${h}` : `UTC${sign}${h}:${String(m).padStart(2, '0')}`;
}

// Half-open range [from, to). `to` is the start of the day AFTER the last
// included day so the backend's `from <= startedAt < to` filter is correct.
function presetRange(preset: Preset, now: Date = new Date()): { from: Date; to: Date } {
  switch (preset) {
    case 'today': {
      const from = startOfDay(now);
      return { from, to: addDays(from, 1) };
    }
    case 'yesterday': {
      const today = startOfDay(now);
      return { from: addDays(today, -1), to: today };
    }
    case 'thisWeek': {
      const from = startOfWeek(now);
      return { from, to: addDays(from, 7) };
    }
    case 'lastWeek': {
      const thisWeek = startOfWeek(now);
      return { from: addDays(thisWeek, -7), to: thisWeek };
    }
    case 'thisMonth': {
      const from = startOfMonth(now);
      return { from, to: addMonths(from, 1) };
    }
    case 'lastMonth': {
      const thisMonth = startOfMonth(now);
      return { from: addMonths(thisMonth, -1), to: thisMonth };
    }
    case 'thisYear': {
      const from = startOfYear(now);
      return { from, to: addYears(from, 1) };
    }
    case 'lastYear': {
      const thisYear = startOfYear(now);
      return { from: addYears(thisYear, -1), to: thisYear };
    }
    case 'custom':
      return { from: startOfMonth(now), to: addMonths(startOfMonth(now), 1) };
  }
}

// ── page ─────────────────────────────────────────────────────────────────

function ReportPage() {
  const params = Route.useParams();

  // ── DRAFT (what's being edited in the filter panel) ────────────────────
  const initial = presetRange('lastMonth');
  const [draftPreset, setDraftPreset] = useState<Preset>('lastMonth');
  const [draftFromIso, setDraftFromIso] = useState<string>(isoDate(initial.from));
  const [draftToIso, setDraftToIso] = useState<string>(isoDate(addDays(initial.to, -1)));
  const [draftEmployeeIds, setDraftEmployeeIds] = useState<string[]>([]);
  const [draftProjectIds, setDraftProjectIds] = useState<string[]>([]);
  const [draftNoteContains, setDraftNoteContains] = useState('');
  const [draftOnlyOffline, setDraftOnlyOffline] = useState(false);
  const [draftExcludeArchived, setDraftExcludeArchived] = useState(false);
  const [draftReportType, setDraftReportType] = useState<ReportType>('summary-by-project');

  // ── APPLIED — derived live from draft state so filter edits take effect
  // immediately. (Previously gated behind a SHOW REPORT button.)
  void initial;

  const [subTab, setSubTab] = useState<SubTab>('timeline');

  // Resolve the draft preset → range (so the date inputs stay in sync).
  const draftRange = useMemo(() => {
    if (draftPreset === 'custom') {
      const f = startOfDay(new Date(draftFromIso));
      const t = addDays(startOfDay(new Date(draftToIso)), 1);
      return { from: f, to: t };
    }
    return presetRange(draftPreset);
  }, [draftPreset, draftFromIso, draftToIso]);

  useEffect(() => {
    if (draftPreset === 'custom') return;
    setDraftFromIso(isoDate(draftRange.from));
    setDraftToIso(isoDate(addDays(draftRange.to, -1)));
  }, [draftPreset, draftRange.from, draftRange.to]);

  // Single source of truth — filters apply live as the user edits them.
  const applied = useMemo<AppliedFilters>(
    () => ({
      preset: draftPreset,
      from: draftRange.from,
      to: draftRange.to,
      employeeIds: draftEmployeeIds,
      projectIds: draftProjectIds,
      noteContains: draftNoteContains,
      excludeArchived: draftExcludeArchived,
      onlyOffline: draftOnlyOffline,
      reportType: draftReportType,
    }),
    [
      draftPreset,
      draftRange.from,
      draftRange.to,
      draftEmployeeIds,
      draftProjectIds,
      draftNoteContains,
      draftExcludeArchived,
      draftOnlyOffline,
      draftReportType,
    ],
  );

  // ── QUERIES (driven by `applied`) ──────────────────────────────────────
  const filters = useMemo(
    () => ({ from: applied.from.toISOString(), to: applied.to.toISOString() }),
    [applied.from, applied.to],
  );

  // Gate the report queries on having at least one Employee or Project picked.
  // Without a scope, we render an empty-state prompt and skip the network calls.
  const hasScope = applied.employeeIds.length > 0 || applied.projectIds.length > 0;

  const totalsQuery = useQuery({
    queryKey: queryKeys.timeTotals(params.orgId, filters),
    queryFn: () => apiGet<TimeTotalsResponse>(`/orgs/${params.orgId}/reports/time-totals`, filters),
    enabled: hasScope,
  });
  const byDayQuery = useQuery({
    queryKey: ['orgs', params.orgId, 'reports', 'time-totals-by-day', filters] as const,
    queryFn: () =>
      apiGet<TimeTotalsByDayResponse>(`/orgs/${params.orgId}/reports/time-totals-by-day`, filters),
    enabled: hasScope,
  });
  const membersQuery = useQuery({
    queryKey: queryKeys.members(params.orgId),
    queryFn: () => apiGet<MembersResponse>(`/orgs/${params.orgId}/members`),
  });
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects(params.orgId, true),
    queryFn: () =>
      apiGet<ProjectsResponse>(`/orgs/${params.orgId}/projects`, { includeArchived: true }),
  });

  // Time entries — needed whenever a view consumes entry-level data, OR when an
  // active filter (employee / project / archived / notes-contains) means the
  // server's aggregated time-totals-by-day can't be used as-is and the chart
  // has to be reconstructed from filtered entries. Otherwise the chart and
  // Daily-by-employee table would silently ignore filters.
  const needsEntries =
    applied.reportType === 'detailed' ||
    applied.reportType === 'daily-by-employee' ||
    subTab === 'notes' ||
    applied.noteContains.trim().length > 0 ||
    applied.employeeIds.length > 0 ||
    applied.projectIds.length > 0 ||
    applied.excludeArchived;
  const entriesQuery = useQuery({
    queryKey: [
      'orgs',
      params.orgId,
      'time-entries',
      { from: filters.from, to: filters.to, limit: 100 },
    ] as const,
    queryFn: () =>
      apiGet<TimeEntriesResponse>(`/orgs/${params.orgId}/time-entries`, {
        from: filters.from,
        to: filters.to,
        limit: 100,
      }),
    enabled: hasScope && needsEntries,
  });

  // ── DERIVED ────────────────────────────────────────────────────────────
  const members = membersQuery.data?.members ?? [];
  const memberById = useMemo(() => new Map(members.map((m) => [m.user.id, m.user])), [members]);
  const projectsAll = projectsQuery.data?.projects ?? [];
  const projectById = useMemo(() => new Map(projectsAll.map((p) => [p.id, p])), [projectsAll]);

  const rawRows = totalsQuery.data?.rows ?? [];
  const archivedIds = useMemo(
    () => new Set(projectsAll.filter((p) => p.archivedAt !== null).map((p) => p.id)),
    [projectsAll],
  );

  const filteredRows = useMemo(() => {
    return rawRows.filter((r) => {
      if (applied.employeeIds.length > 0 && !applied.employeeIds.includes(r.userId)) return false;
      if (applied.projectIds.length > 0 && !applied.projectIds.includes(r.projectId)) return false;
      if (applied.excludeArchived && archivedIds.has(r.projectId)) return false;
      return true;
    });
  }, [rawRows, applied.employeeIds, applied.projectIds, applied.excludeArchived, archivedIds]);

  const rawEntries = entriesQuery.data?.entries ?? [];
  const filteredEntries = useMemo(() => {
    const q = applied.noteContains.trim().toLowerCase();
    return rawEntries.filter((e) => {
      if (applied.employeeIds.length > 0 && !applied.employeeIds.includes(e.userId)) return false;
      if (applied.projectIds.length > 0 && !applied.projectIds.includes(e.projectId)) return false;
      if (applied.excludeArchived && archivedIds.has(e.projectId)) return false;
      if (q && !(e.notes ?? '').toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rawEntries, applied, archivedIds]);

  // For the day chart: when no employee/project filter, use the server's
  // per-day totals; otherwise reconstruct day buckets from filtered entries so
  // the chart matches the table.
  const dayCount = Math.max(1, diffDays(applied.from, applied.to));
  const days = useMemo(() => {
    const out: { date: Date; total: number }[] = [];
    const filteringByEntries =
      applied.employeeIds.length > 0 ||
      applied.projectIds.length > 0 ||
      applied.excludeArchived ||
      applied.noteContains.trim().length > 0;

    if (filteringByEntries && rawEntries.length > 0) {
      const buckets = new Array(dayCount).fill(0) as number[];
      for (const e of filteredEntries) {
        const idx = Math.floor(
          (new Date(e.startedAt).getTime() - applied.from.getTime()) / 86_400_000,
        );
        if (idx >= 0 && idx < dayCount) buckets[idx] = (buckets[idx] ?? 0) + e.totalActiveSeconds;
      }
      for (let i = 0; i < dayCount; i++) {
        out.push({ date: addDays(applied.from, i), total: buckets[i] ?? 0 });
      }
      return out;
    }

    const src = byDayQuery.data?.days ?? [];
    for (let i = 0; i < dayCount; i++) {
      out.push({ date: addDays(applied.from, i), total: src[i]?.totalActiveSeconds ?? 0 });
    }
    return out;
  }, [byDayQuery.data, dayCount, applied, filteredEntries, rawEntries]);

  const totalSeconds = filteredRows.reduce((s, r) => s + r.totalActiveSeconds, 0);
  const totalEarnedCents = filteredRows.reduce((s, r) => s + (r.earnedCents ?? 0), 0);
  const anyEarned = filteredRows.some((r) => r.earnedCents !== null);

  // ── EXPORTS ────────────────────────────────────────────────────────────
  const onExportExcel = () =>
    exportExcel(applied, filteredRows, filteredEntries, memberById, projectById);
  const onExportPdf = () => {
    document.body.classList.add('printing-report');
    const cleanup = () => {
      document.body.classList.remove('printing-report');
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    // Defer one tick so the body class is applied before the print dialog
    // captures the layout.
    setTimeout(() => window.print(), 50);
  };

  const isLoading =
    totalsQuery.isLoading || byDayQuery.isLoading || (needsEntries && entriesQuery.isLoading);
  const error = totalsQuery.error ?? byDayQuery.error ?? (needsEntries ? entriesQuery.error : null);

  return (
    <div className="px-7 py-6">
      <HeaderActionsPortal>
        <span className="text-[11.5px] text-ink3">
          Report times are{' '}
          <span className="font-mono font-medium text-foreground">{timezoneLabel()}</span>
        </span>
      </HeaderActionsPortal>

      <header className="mb-4 print:mb-2">
        <h1 className="text-[26px] font-semibold tracking-tight">Report</h1>
        <p className="mt-1 text-[13px] text-ink3 print:hidden">
          Pick a date range, slice it however you like — then read the totals.
        </p>
      </header>

      {/* Filter panel ───────────────────────────────────────────────────── */}
      <section className="mb-5 overflow-visible rounded-lg border border-border bg-card print:hidden">
        <div className="flex flex-wrap items-start gap-x-6 gap-y-3 border-b border-border bg-muted/30 px-4 py-3.5">
          <DateRangeField
            from={draftFromIso}
            to={draftToIso}
            onFromChange={(v) => {
              setDraftFromIso(v);
              setDraftPreset('custom');
            }}
            onToChange={(v) => {
              setDraftToIso(v);
              setDraftPreset('custom');
            }}
          />
          <PresetGrid value={draftPreset} onChange={setDraftPreset} />
        </div>

        <div className="space-y-2 px-4 py-3">
          <MultiSelectField
            placeholder="Select employees"
            options={members.map((m) => ({ id: m.user.id, label: m.user.name }))}
            selected={draftEmployeeIds}
            onChange={setDraftEmployeeIds}
          />
          <MultiSelectField
            placeholder="Select projects"
            options={projectsAll.map((p) => ({
              id: p.id,
              label: p.name + (p.archivedAt ? ' (archived)' : ''),
            }))}
            selected={draftProjectIds}
            onChange={setDraftProjectIds}
          />
          <NoteFilter value={draftNoteContains} onChange={setDraftNoteContains} />
        </div>

        <div className="border-t border-border px-4">
          <ReportTypeTabs value={draftReportType} onChange={setDraftReportType} />
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-border bg-muted/20 px-4 py-3">
          <GroupByChip label={groupByLabelFor(draftReportType)} />
          <div className="ml-auto flex flex-wrap items-center gap-4 text-[12.5px] text-ink2">
            <Toggle
              checked={draftOnlyOffline}
              onChange={setDraftOnlyOffline}
              label="Only offline activities"
            />
            <Toggle
              checked={draftExcludeArchived}
              onChange={setDraftExcludeArchived}
              label="Exclude archived"
            />
            <div className="flex items-center gap-3 border-l border-border pl-4 text-ink3">
              <ExportLink
                icon={<FileSpreadsheet className="h-3.5 w-3.5" />}
                label="Excel"
                onClick={onExportExcel}
              />
              <ExportLink
                icon={<FileText className="h-3.5 w-3.5" />}
                label="PDF"
                onClick={onExportPdf}
              />
              <ExportLink icon={<Share2 className="h-3.5 w-3.5" />} label="Share report" />
              <ExportLink icon={<Bookmark className="h-3.5 w-3.5" />} label="Save report" />
            </div>
          </div>
        </div>
      </section>

      {/* Sub-tabs ───────────────────────────────────────────────────────── */}
      <div className="mb-3 flex items-center gap-1 border-b border-border print:hidden">
        {(
          [
            { key: 'timeline', label: 'Timeline' },
            { key: 'employees', label: 'Employees' },
            { key: 'projects', label: 'Projects' },
            { key: 'notes', label: 'Notes' },
            { key: 'apps-urls', label: 'Apps & URLs' },
          ] as const
        ).map((t) => (
          <SubTabButton
            key={t.key}
            active={subTab === t.key}
            onClick={() => setSubTab(t.key)}
            label={t.label}
          />
        ))}
      </div>

      {/* Content ────────────────────────────────────────────────────────── */}
      {!hasScope ? (
        <ScopePrompt />
      ) : isLoading ? (
        <Skeleton className="h-72 w-full" />
      ) : error ? (
        <div className="rounded-md border border-dashed border-border py-12 text-center text-[13px] text-destructive">
          {error instanceof Error ? error.message : 'Could not load report.'}
        </div>
      ) : (
        <>
          {/* Top panel — varies by sub-tab */}
          {subTab === 'timeline' && (
            <TimelinePanel
              totalSeconds={totalSeconds}
              days={days}
              earnedCents={anyEarned ? totalEarnedCents : null}
            />
          )}
          {subTab === 'employees' && (
            <EmployeesBarPanel rows={filteredRows} memberById={memberById} />
          )}
          {subTab === 'projects' && <ProjectsBarPanel rows={filteredRows} />}
          {subTab === 'notes' && (
            <NotesPanel
              entries={filteredEntries}
              memberById={memberById}
              projectById={projectById}
            />
          )}
          {subTab === 'apps-urls' && <PanelStub tab="apps-urls" />}

          {/* Bottom report — varies by report type */}
          {applied.reportType === 'summary-by-project' && (
            <ProjectsTable rows={filteredRows} totalSeconds={totalSeconds} />
          )}
          {applied.reportType === 'summary-by-employee' && (
            <EmployeesTable rows={filteredRows} totalSeconds={totalSeconds} />
          )}
          {applied.reportType === 'daily-by-employee' && (
            <DailyByEmployeeTable
              entries={filteredEntries}
              memberById={memberById}
              from={applied.from}
              dayCount={dayCount}
            />
          )}
          {applied.reportType === 'detailed' && (
            <DetailedTable
              entries={filteredEntries}
              memberById={memberById}
              projectById={projectById}
            />
          )}
          {applied.reportType === 'apps-urls' && <PanelStub tab="apps-urls" />}
        </>
      )}
    </div>
  );
}

// ── date range picker ────────────────────────────────────────────────────

function DateRangeField({
  from,
  to,
  onFromChange,
  onToChange,
}: {
  from: string;
  to: string;
  onFromChange: (v: string) => void;
  onToChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 shadow-sm">
      <Calendar className="h-3.5 w-3.5 text-ink4" />
      <DateInput value={from} display={shortDate(new Date(from))} onChange={onFromChange} />
      <span className="text-ink4">▶</span>
      <DateInput value={to} display={shortDate(new Date(to))} onChange={onToChange} />
    </div>
  );
}

function DateInput({
  value,
  display,
  onChange,
}: {
  value: string;
  display: string;
  onChange: (v: string) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <label className="relative inline-flex cursor-pointer items-center">
      <input
        ref={ref}
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="peer absolute inset-0 cursor-pointer opacity-0"
        aria-label={`Date ${display}`}
      />
      <span className="select-none rounded px-1.5 py-0.5 font-mono text-[12.5px] tabular-nums text-foreground peer-focus:bg-muted">
        {display}
      </span>
    </label>
  );
}

function PresetGrid({ value, onChange }: { value: Preset; onChange: (v: Preset) => void }) {
  const cols: { top: { key: Preset; label: string }; bottom: { key: Preset; label: string } }[] = [
    {
      top: { key: 'today', label: 'Today' },
      bottom: { key: 'yesterday', label: 'Yesterday' },
    },
    {
      top: { key: 'thisWeek', label: 'This Week' },
      bottom: { key: 'lastWeek', label: 'Last Week' },
    },
    {
      top: { key: 'thisMonth', label: 'This Month' },
      bottom: { key: 'lastMonth', label: 'Last Month' },
    },
    {
      top: { key: 'thisYear', label: 'This Year' },
      bottom: { key: 'lastYear', label: 'Last Year' },
    },
  ];
  return (
    <div className="flex flex-wrap gap-x-7 gap-y-1 text-[13px]">
      {cols.map((c) => (
        <div key={c.top.key} className="flex flex-col items-start">
          <PresetButton active={value === c.top.key} onClick={() => onChange(c.top.key)}>
            {c.top.label}
          </PresetButton>
          <PresetButton active={value === c.bottom.key} onClick={() => onChange(c.bottom.key)}>
            {c.bottom.label}
          </PresetButton>
        </div>
      ))}
    </div>
  );
}

function PresetButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'rounded px-1 py-0.5 transition-colors ' +
        (active
          ? 'font-semibold text-foreground'
          : 'text-[#2f6cb3] hover:text-foreground dark:text-[#7aa8e6]')
      }
    >
      {children}
    </button>
  );
}

// ── multi-select dropdown ────────────────────────────────────────────────

interface Option {
  id: string;
  label: string;
}

function MultiSelectField({
  placeholder,
  options,
  selected,
  onChange,
}: {
  placeholder: string;
  options: Option[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const selectedSet = new Set(selected);
  const selectedOptions = options.filter((o) => selectedSet.has(o.id));
  const filtered = search
    ? options.filter((o) => o.label.toLowerCase().includes(search.toLowerCase()))
    : options;

  const toggle = (id: string) => {
    if (selectedSet.has(id)) onChange(selected.filter((x) => x !== id));
    else onChange([...selected, id]);
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-10 w-full items-center gap-2 rounded-md border border-input bg-background px-2.5 text-left text-[13px] focus:outline-none focus:ring-2 focus:ring-ring"
      >
        {selectedOptions.length === 0 ? (
          <span className="flex-1 text-ink4">{placeholder}</span>
        ) : (
          <div className="flex flex-1 flex-wrap items-center gap-1">
            {selectedOptions.map((o) => (
              <span
                key={o.id}
                className="inline-flex items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 text-[12px]"
              >
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggle(o.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      e.stopPropagation();
                      toggle(o.id);
                    }
                  }}
                  className="text-ink4 hover:text-foreground"
                  aria-label={`Remove ${o.label}`}
                >
                  <X className="h-3 w-3" />
                </span>
                {o.label}
              </span>
            ))}
          </div>
        )}
        <ChevronDown className="h-3.5 w-3.5 text-ink4" />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 rounded-md border border-border bg-card shadow-md">
          <div className="flex items-center gap-2 border-b border-border px-2.5 py-1.5">
            <Search className="h-3.5 w-3.5 text-ink4" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search..."
              className="w-full bg-transparent text-[12.5px] outline-none placeholder:text-ink4"
              autoFocus
            />
          </div>
          <ul className="max-h-60 overflow-y-auto py-1 text-[12.5px]">
            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-ink4">No matches</li>
            ) : (
              filtered.map((o) => {
                const checked = selectedSet.has(o.id);
                return (
                  <li key={o.id}>
                    <button
                      type="button"
                      onClick={() => toggle(o.id)}
                      className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-muted"
                    >
                      <input type="checkbox" checked={checked} readOnly className="h-3.5 w-3.5" />
                      <span>{o.label}</span>
                    </button>
                  </li>
                );
              })
            )}
          </ul>
          {selected.length > 0 && (
            <div className="flex items-center justify-between border-t border-border px-2.5 py-1.5 text-[11.5px] text-ink3">
              <span>{selected.length} selected</span>
              <button
                type="button"
                onClick={() => onChange([])}
                className="text-[#2f6cb3] hover:text-foreground dark:text-[#7aa8e6]"
              >
                Clear all
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function NoteFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Note contains text"
      className="flex h-10 w-full items-center gap-2 rounded-md border border-input bg-background px-2.5 text-[13px] placeholder:text-ink4 focus:outline-none focus:ring-2 focus:ring-ring"
    />
  );
}

// ── report-type tabs ─────────────────────────────────────────────────────

function ReportTypeTabs({
  value,
  onChange,
}: {
  value: ReportType;
  onChange: (v: ReportType) => void;
}) {
  const items: { key: ReportType; label: string }[] = [
    { key: 'summary-by-project', label: 'Summary by project' },
    { key: 'summary-by-employee', label: 'Summary by employee' },
    { key: 'daily-by-employee', label: 'Daily by employee' },
    { key: 'detailed', label: 'Detailed' },
    { key: 'apps-urls', label: 'Apps & URLs' },
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 py-2.5 text-[13px]">
      {items.map((it) => {
        const active = value === it.key;
        return (
          <button
            key={it.key}
            type="button"
            onClick={() => onChange(it.key)}
            className={
              active
                ? 'font-semibold text-foreground underline underline-offset-[6px] decoration-[1.5px]'
                : 'text-[#2f6cb3] hover:text-foreground dark:text-[#7aa8e6]'
            }
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

function groupByLabelFor(rt: ReportType): string {
  switch (rt) {
    case 'summary-by-project':
      return 'Group by project';
    case 'summary-by-employee':
      return 'Group by employee';
    case 'daily-by-employee':
      return 'Group by day · employee';
    case 'detailed':
      return 'Group by entry';
    case 'apps-urls':
      return 'Group by app';
  }
}

function GroupByChip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-2 py-1 text-[12.5px]">
      <span className="text-ink4">
        <X className="h-3 w-3" />
      </span>
      <span>{label}</span>
      <ChevronDown className="ml-1 h-3.5 w-3.5 text-ink4" />
    </span>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-[12.5px] text-ink2">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 rounded border-input"
      />
      {label}
    </label>
  );
}

function ExportLink({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 text-[12.5px] text-[#2f6cb3] hover:text-foreground dark:text-[#7aa8e6]"
    >
      {icon}
      {label}
    </button>
  );
}

// ── sub-tabs ─────────────────────────────────────────────────────────────

function SubTabButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'relative px-3 py-2 text-[12.5px] transition-colors ' +
        (active ? 'font-medium text-foreground' : 'text-ink3 hover:text-foreground')
      }
    >
      {label}
      {active && (
        <span className="absolute inset-x-2 -bottom-px h-[2px] rounded-full bg-foreground" />
      )}
    </button>
  );
}

// ── timeline panel (big total + daily bar chart) ─────────────────────────

function TimelinePanel({
  totalSeconds,
  days,
  earnedCents,
}: {
  totalSeconds: number;
  days: { date: Date; total: number }[];
  earnedCents: number | null;
}) {
  const maxSeconds = Math.max(...days.map((d) => d.total), 3600);
  const ceiling = Math.max(4 * 3600, Math.ceil(maxSeconds / (4 * 3600)) * (4 * 3600));

  return (
    <section className="mb-4 rounded-lg border border-border bg-card px-5 py-5">
      <div className="grid grid-cols-[auto,1fr] items-center gap-8">
        <div>
          <div className="text-[36px] font-semibold tracking-tight tabular-nums">
            {formatTotal(totalSeconds)}
          </div>
          {earnedCents !== null && (
            <div className="mt-1 text-[13px] text-ink3">
              <span className="font-mono font-medium text-foreground">
                {formatMoney(earnedCents)}
              </span>{' '}
              billable
            </div>
          )}
        </div>
        <div className="min-w-0 overflow-x-auto">
          <div
            className="grid items-end gap-1.5 pb-7 pt-7"
            style={{
              gridTemplateColumns: `repeat(${days.length}, minmax(${days.length > 20 ? 26 : 36}px, 1fr))`,
              minWidth: days.length > 20 ? `${days.length * 30}px` : undefined,
            }}
          >
            {days.map((d, i) => {
              const heightPct = ceiling > 0 ? (d.total / ceiling) * 100 : 0;
              const dow = d.date.getDay();
              const weekend = dow === 0 || dow === 6;
              const label = `${DAY_SHORT[dow]} ${MONTH_SHORT[d.date.getMonth()]} ${d.date.getDate()}`;
              return (
                <div key={i} className="relative flex h-[180px] flex-col items-center justify-end">
                  <div
                    className="relative w-full overflow-hidden rounded-t-sm bg-[#7da7be]"
                    style={{ height: `${heightPct}%`, minHeight: d.total > 0 ? 4 : 0 }}
                    title={`${label} · ${formatHours(d.total)}`}
                  >
                    {d.total > 0 && heightPct > 18 && (
                      <span
                        className="absolute inset-x-0 top-1.5 text-center font-mono text-[10px] text-white/95"
                        style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
                      >
                        {formatHours(d.total)}
                      </span>
                    )}
                  </div>

                  <div
                    className={
                      'absolute -bottom-6 whitespace-nowrap text-[10.5px] leading-tight ' +
                      (weekend ? 'font-medium text-rose-500' : 'text-ink3')
                    }
                  >
                    <div className="text-center">{DAY_SHORT[dow]}</div>
                    <div className="text-center">
                      {MONTH_SHORT[d.date.getMonth()]} {d.date.getDate()}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

// 152h 03m — zero-padded minutes for the big total.
function formatTotal(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

// ── alternate top panels ─────────────────────────────────────────────────

function EmployeesBarPanel({
  rows,
  memberById,
}: {
  rows: TimeTotalRow[];
  memberById: Map<string, UserDto>;
}) {
  const grouped = useMemo(() => groupUsers(rows), [rows]);
  const total = grouped.reduce((s, g) => s + g.totalSeconds, 0);
  return (
    <section className="mb-4 rounded-lg border border-border bg-card px-5 py-5">
      <div className="mb-4 text-[36px] font-semibold tracking-tight tabular-nums">
        {formatTotal(total)}
      </div>
      {grouped.length === 0 ? (
        <p className="py-6 text-center text-[13px] text-ink3">No tracked time in this range.</p>
      ) : (
        <ul className="space-y-2">
          {grouped.map((u) => {
            const share = total > 0 ? (u.totalSeconds / total) * 100 : 0;
            const user = memberById.get(u.userId);
            return (
              <li key={u.userId} className="flex items-center gap-3 text-[13px]">
                <div className="flex w-44 min-w-0 items-center gap-2">
                  <AvatarLive userId={u.userId} name={user?.name ?? u.userName} size={22} />
                  <span className="truncate font-medium">{user?.name ?? u.userName}</span>
                </div>
                <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-[#7da7be]"
                    style={{ width: `${share}%` }}
                  />
                </div>
                <div className="w-24 text-right font-mono tabular-nums text-ink2">
                  {formatTotal(u.totalSeconds)}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function ProjectsBarPanel({ rows }: { rows: TimeTotalRow[] }) {
  const grouped = useMemo(() => groupProjects(rows), [rows]);
  const total = grouped.reduce((s, g) => s + g.totalSeconds, 0);
  return (
    <section className="mb-4 rounded-lg border border-border bg-card px-5 py-5">
      <div className="mb-4 text-[36px] font-semibold tracking-tight tabular-nums">
        {formatTotal(total)}
      </div>
      {grouped.length === 0 ? (
        <p className="py-6 text-center text-[13px] text-ink3">No tracked time in this range.</p>
      ) : (
        <ul className="space-y-2">
          {grouped.map((p) => {
            const share = total > 0 ? (p.totalSeconds / total) * 100 : 0;
            return (
              <li key={p.projectId} className="flex items-center gap-3 text-[13px]">
                <div className="flex w-44 min-w-0 items-center gap-2">
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-sm"
                    style={{ background: projectAccent(p.projectId) }}
                  />
                  <span className="truncate font-medium">{p.projectName}</span>
                </div>
                <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${share}%`, background: projectAccent(p.projectId) }}
                  />
                </div>
                <div className="w-24 text-right font-mono tabular-nums text-ink2">
                  {formatTotal(p.totalSeconds)}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function NotesPanel({
  entries,
  memberById,
  projectById,
}: {
  entries: TimeEntryDto[];
  memberById: Map<string, UserDto>;
  projectById: Map<string, ProjectDto>;
}) {
  const withNotes = entries.filter((e) => (e.notes ?? '').trim().length > 0);
  return (
    <section className="mb-4 rounded-lg border border-border bg-card">
      <div className="border-b border-border bg-muted/40 px-4 py-2.5 text-[11px] uppercase tracking-wide text-ink3">
        Notes
      </div>
      {withNotes.length === 0 ? (
        <p className="py-10 text-center text-[13px] text-ink3">No notes in this range.</p>
      ) : (
        <ul className="divide-y divide-border">
          {withNotes.map((e) => {
            const m = memberById.get(e.userId);
            const p = projectById.get(e.projectId);
            return (
              <li
                key={e.id}
                className="grid grid-cols-[180px,1fr,auto] items-start gap-3 px-4 py-3 text-[13px]"
              >
                <div className="flex items-center gap-2 text-[12px] text-ink3">
                  {m ? (
                    <>
                      <AvatarLive userId={m.id} name={m.name} size={20} />
                      <span className="truncate">{m.name}</span>
                    </>
                  ) : (
                    <span className="text-ink4">Unknown</span>
                  )}
                </div>
                <div>
                  <div className="text-[13px]">{e.notes}</div>
                  <div className="mt-0.5 flex items-center gap-2 text-[11.5px] text-ink4">
                    <span
                      className="inline-block h-1.5 w-1.5 rounded-sm"
                      style={{ background: projectAccent(e.projectId) }}
                    />
                    <span>{p?.name ?? 'Unknown project'}</span>
                    <span>·</span>
                    <span>{new Date(e.startedAt).toLocaleDateString()}</span>
                  </div>
                </div>
                <div className="font-mono text-[12.5px] tabular-nums text-ink2">
                  {formatHours(e.totalActiveSeconds)}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ── report body tables ───────────────────────────────────────────────────

interface ProjectGroup {
  projectId: string;
  projectName: string;
  totalSeconds: number;
}
interface UserGroup {
  userId: string;
  userName: string;
  userEmail: string;
  totalSeconds: number;
}

function groupProjects(rows: TimeTotalRow[]): ProjectGroup[] {
  const map = new Map<string, ProjectGroup>();
  for (const r of rows) {
    let g = map.get(r.projectId);
    if (!g) {
      g = { projectId: r.projectId, projectName: r.projectName, totalSeconds: 0 };
      map.set(r.projectId, g);
    }
    g.totalSeconds += r.totalActiveSeconds;
  }
  return Array.from(map.values()).sort((a, b) => b.totalSeconds - a.totalSeconds);
}

function groupUsers(rows: TimeTotalRow[]): UserGroup[] {
  const map = new Map<string, UserGroup>();
  for (const r of rows) {
    let g = map.get(r.userId);
    if (!g) {
      g = {
        userId: r.userId,
        userName: r.userName,
        userEmail: r.userEmail,
        totalSeconds: 0,
      };
      map.set(r.userId, g);
    }
    g.totalSeconds += r.totalActiveSeconds;
  }
  return Array.from(map.values()).sort((a, b) => b.totalSeconds - a.totalSeconds);
}

function ProjectsTable({ rows, totalSeconds }: { rows: TimeTotalRow[]; totalSeconds: number }) {
  const grouped = useMemo(() => groupProjects(rows), [rows]);
  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="grid grid-cols-[1fr,auto] items-center gap-3 border-b border-border bg-muted/40 px-4 py-2.5 text-[11px] uppercase tracking-wide text-ink3">
        <div>Project</div>
        <div>Duration</div>
      </div>
      {grouped.length === 0 ? (
        <div className="px-4 py-10 text-center text-[13px] text-ink3">
          No tracked time in this range.
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {grouped.map((p) => (
            <li
              key={p.projectId}
              className="grid grid-cols-[1fr,auto] items-center gap-3 px-4 py-3 text-[13px]"
            >
              <div className="flex items-center gap-2">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-sm"
                  style={{ background: projectAccent(p.projectId) }}
                />
                <span className="font-medium">{p.projectName}</span>
              </div>
              <div className="font-mono tabular-nums text-ink2">{formatTotal(p.totalSeconds)}</div>
            </li>
          ))}
          {totalSeconds > 0 && (
            <li className="grid grid-cols-[1fr,auto] items-center gap-3 bg-muted/30 px-4 py-3 text-[13px]">
              <div className="font-semibold">Total</div>
              <div className="font-mono font-semibold tabular-nums">
                {formatTotal(totalSeconds)}
              </div>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

function EmployeesTable({ rows, totalSeconds }: { rows: TimeTotalRow[]; totalSeconds: number }) {
  const grouped = useMemo(() => groupUsers(rows), [rows]);
  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="grid grid-cols-[1fr,auto] items-center gap-3 border-b border-border bg-muted/40 px-4 py-2.5 text-[11px] uppercase tracking-wide text-ink3">
        <div>Employee</div>
        <div>Duration</div>
      </div>
      {grouped.length === 0 ? (
        <div className="px-4 py-10 text-center text-[13px] text-ink3">
          No tracked time in this range.
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {grouped.map((u) => (
            <li
              key={u.userId}
              className="grid grid-cols-[1fr,auto] items-center gap-3 px-4 py-3 text-[13px]"
            >
              <div className="flex items-center gap-2.5">
                <AvatarLive userId={u.userId} name={u.userName} size={22} />
                <div className="min-w-0">
                  <div className="truncate font-medium">{u.userName}</div>
                  <div className="truncate text-[11.5px] text-ink4">{u.userEmail}</div>
                </div>
              </div>
              <div className="font-mono tabular-nums text-ink2">{formatTotal(u.totalSeconds)}</div>
            </li>
          ))}
          {totalSeconds > 0 && (
            <li className="grid grid-cols-[1fr,auto] items-center gap-3 bg-muted/30 px-4 py-3 text-[13px]">
              <div className="font-semibold">Total</div>
              <div className="font-mono font-semibold tabular-nums">
                {formatTotal(totalSeconds)}
              </div>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

function DailyByEmployeeTable({
  entries,
  memberById,
  from,
  dayCount,
}: {
  entries: TimeEntryDto[];
  memberById: Map<string, UserDto>;
  from: Date;
  dayCount: number;
}) {
  const matrix = useMemo(() => {
    const byUser = new Map<string, { user: UserDto | null; days: number[]; total: number }>();
    for (const e of entries) {
      const idx = Math.floor((new Date(e.startedAt).getTime() - from.getTime()) / 86_400_000);
      if (idx < 0 || idx >= dayCount) continue;
      let row = byUser.get(e.userId);
      if (!row) {
        row = {
          user: memberById.get(e.userId) ?? null,
          days: new Array(dayCount).fill(0),
          total: 0,
        };
        byUser.set(e.userId, row);
      }
      row.days[idx] = (row.days[idx] ?? 0) + e.totalActiveSeconds;
      row.total += e.totalActiveSeconds;
    }
    return Array.from(byUser.entries())
      .map(([userId, v]) => ({ userId, ...v }))
      .sort((a, b) => b.total - a.total);
  }, [entries, memberById, from, dayCount]);

  const dayTotals = useMemo(() => {
    const t = new Array(dayCount).fill(0) as number[];
    for (const row of matrix) {
      for (let i = 0; i < dayCount; i++) t[i] = (t[i] ?? 0) + (row.days[i] ?? 0);
    }
    return t;
  }, [matrix, dayCount]);
  const grandTotal = dayTotals.reduce((s, n) => s + n, 0);

  if (matrix.length === 0) {
    return (
      <section className="rounded-lg border border-border bg-card px-4 py-10 text-center text-[13px] text-ink3">
        No tracked time in this range.
      </section>
    );
  }

  return (
    <section className="overflow-x-auto rounded-lg border border-border bg-card">
      <table className="w-full text-[12.5px]">
        <thead>
          <tr className="border-b border-border bg-muted/40 text-[11px] uppercase tracking-wide text-ink3">
            <th className="sticky left-0 bg-muted/40 px-4 py-2.5 text-left font-medium">
              Employee
            </th>
            {Array.from({ length: dayCount }).map((_, i) => {
              const d = addDays(from, i);
              const dow = d.getDay();
              const weekend = dow === 0 || dow === 6;
              return (
                <th
                  key={i}
                  className={
                    'px-2 py-2.5 text-right font-medium ' +
                    (weekend ? 'text-rose-500' : 'text-ink3')
                  }
                >
                  {String(d.getDate()).padStart(2, '0')}
                </th>
              );
            })}
            <th className="px-3 py-2.5 text-right font-medium text-ink2">Total</th>
          </tr>
        </thead>
        <tbody>
          {matrix.map((row) => (
            <tr key={row.userId} className="border-b border-border last:border-b-0">
              <td className="sticky left-0 bg-card px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <AvatarLive userId={row.userId} name={row.user?.name ?? row.userId} size={20} />
                  <span className="truncate font-medium">{row.user?.name ?? 'Unknown user'}</span>
                </div>
              </td>
              {row.days.map((sec, i) => (
                <td
                  key={i}
                  className={
                    'px-2 py-2.5 text-right font-mono tabular-nums ' +
                    (sec > 0 ? 'text-ink2' : 'text-ink4')
                  }
                >
                  {sec > 0 ? (sec / 3600).toFixed(1) : '—'}
                </td>
              ))}
              <td className="px-3 py-2.5 text-right font-mono font-medium tabular-nums">
                {formatTotal(row.total)}
              </td>
            </tr>
          ))}
          <tr className="bg-muted/30">
            <td className="sticky left-0 bg-muted/30 px-4 py-2.5 font-semibold">Total</td>
            {dayTotals.map((sec, i) => (
              <td key={i} className="px-2 py-2.5 text-right font-mono font-semibold tabular-nums">
                {sec > 0 ? (sec / 3600).toFixed(1) : '—'}
              </td>
            ))}
            <td className="px-3 py-2.5 text-right font-mono font-semibold tabular-nums">
              {formatTotal(grandTotal)}
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}

function DetailedTable({
  entries,
  memberById,
  projectById,
}: {
  entries: TimeEntryDto[];
  memberById: Map<string, UserDto>;
  projectById: Map<string, ProjectDto>;
}) {
  const sorted = useMemo(
    () =>
      [...entries].sort(
        (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
      ),
    [entries],
  );
  const total = sorted.reduce((s, e) => s + e.totalActiveSeconds, 0);

  if (sorted.length === 0) {
    return (
      <section className="rounded-lg border border-border bg-card px-4 py-10 text-center text-[13px] text-ink3">
        No tracked time in this range.
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="grid grid-cols-[180px,200px,90px,90px,1fr,90px] items-center gap-3 border-b border-border bg-muted/40 px-4 py-2.5 text-[11px] uppercase tracking-wide text-ink3">
        <div>Employee</div>
        <div>Project</div>
        <div>Start</div>
        <div>End</div>
        <div>Note</div>
        <div className="text-right">Duration</div>
      </div>
      <ul className="divide-y divide-border">
        {sorted.map((e) => {
          const m = memberById.get(e.userId);
          const p = projectById.get(e.projectId);
          return (
            <li
              key={e.id}
              className="grid grid-cols-[180px,200px,90px,90px,1fr,90px] items-center gap-3 px-4 py-2.5 text-[13px]"
            >
              <div className="flex min-w-0 items-center gap-2">
                {m ? (
                  <>
                    <AvatarLive userId={m.id} name={m.name} size={20} />
                    <span className="truncate">{m.name}</span>
                  </>
                ) : (
                  <span className="text-ink4">Unknown</span>
                )}
              </div>
              <div className="flex min-w-0 items-center gap-1.5">
                <span
                  className="inline-block h-2 w-2 rounded-sm"
                  style={{ background: projectAccent(e.projectId) }}
                />
                <span className="truncate">{p?.name ?? '—'}</span>
              </div>
              <div className="font-mono text-[12px] text-ink2">{formatDateTime(e.startedAt)}</div>
              <div className="font-mono text-[12px] text-ink2">
                {e.endedAt ? formatDateTime(e.endedAt) : 'In progress'}
              </div>
              <div className="truncate text-ink2">{e.notes ?? '—'}</div>
              <div className="text-right font-mono font-medium tabular-nums">
                {formatTotal(e.totalActiveSeconds)}
              </div>
            </li>
          );
        })}
        <li className="grid grid-cols-[180px,200px,90px,90px,1fr,90px] items-center gap-3 bg-muted/30 px-4 py-2.5 text-[13px]">
          <div className="font-semibold">Total</div>
          <div />
          <div />
          <div />
          <div />
          <div className="text-right font-mono font-semibold tabular-nums">
            {formatTotal(total)}
          </div>
        </li>
      </ul>
    </section>
  );
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return `${MONTH_SHORT[d.getMonth()]} ${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ── empty state when no filter has been picked ───────────────────────────

function ScopePrompt() {
  return (
    <section className="rounded-lg border border-dashed border-border bg-card px-5 py-16 text-center">
      <p className="text-[15px] font-medium text-foreground">Pick a filter to run the report</p>
      <p className="mx-auto mt-1.5 max-w-md text-[13px] text-ink3">
        Select at least one employee or project above. The report stays empty until something is
        scoped — that way you never see numbers that aren&apos;t the ones you asked for.
      </p>
    </section>
  );
}

// ── stub for unsupported tabs ────────────────────────────────────────────

function PanelStub({ tab }: { tab: SubTab | 'apps-urls' }) {
  const isApps = tab === 'apps-urls';
  return (
    <section className="mb-4 rounded-lg border border-dashed border-border bg-card px-5 py-12 text-center">
      <p className="text-[13px] text-ink3">
        {isApps
          ? 'Apps & URLs tracking is not wired yet — coming next.'
          : 'This view is coming next.'}
      </p>
    </section>
  );
}

// ── header portal ────────────────────────────────────────────────────────

function HeaderActionsPortal({ children }: { children: React.ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setTarget(document.getElementById('page-header-actions'));
  }, []);
  if (!target) return null;
  return createPortal(children, target);
}

// SpreadsheetML 2003 XML — opens natively in Excel and Numbers without any
// dependencies. We build the same row set the CSV path produces, then escape
// and wrap each cell for the XML format.
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildExcelRows(
  applied: AppliedFilters,
  rows: TimeTotalRow[],
  entries: TimeEntryDto[],
  memberById: Map<string, UserDto>,
  projectById: Map<string, ProjectDto>,
): { header: string[]; body: string[][] } {
  if (applied.reportType === 'detailed') {
    const header = ['Employee', 'Project', 'Start', 'End', 'Note', 'Duration'];
    const body: string[][] = [];
    for (const e of entries) {
      const m = memberById.get(e.userId);
      const p = projectById.get(e.projectId);
      body.push([
        m?.name ?? '',
        p?.name ?? '',
        new Date(e.startedAt).toISOString(),
        e.endedAt ? new Date(e.endedAt).toISOString() : '',
        e.notes ?? '',
        formatHours(e.totalActiveSeconds),
      ]);
    }
    return { header, body };
  }
  if (applied.reportType === 'summary-by-employee') {
    const header = ['Employee', 'Email', 'Duration'];
    const body = groupUsers(rows).map((u) => [
      u.userName,
      u.userEmail,
      formatHours(u.totalSeconds),
    ]);
    return { header, body };
  }
  const header = ['Project', 'Duration'];
  const body = groupProjects(rows).map((p) => [p.projectName, formatHours(p.totalSeconds)]);
  return { header, body };
}

function exportExcel(
  applied: AppliedFilters,
  rows: TimeTotalRow[],
  entries: TimeEntryDto[],
  memberById: Map<string, UserDto>,
  projectById: Map<string, ProjectDto>,
): void {
  const { header, body } = buildExcelRows(applied, rows, entries, memberById, projectById);
  const renderRow = (cells: string[]) =>
    `<Row>${cells
      .map((c) => `<Cell><Data ss:Type="String">${xmlEscape(c)}</Data></Cell>`)
      .join('')}</Row>`;
  const headerRow = `<Row>${header
    .map((c) => `<Cell ss:StyleID="hdr"><Data ss:Type="String">${xmlEscape(c)}</Data></Cell>`)
    .join('')}</Row>`;
  const xml = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
  <Styles>
    <Style ss:ID="hdr"><Font ss:Bold="1"/></Style>
  </Styles>
  <Worksheet ss:Name="Report">
    <Table>
      ${headerRow}
      ${body.map(renderRow).join('\n      ')}
    </Table>
  </Worksheet>
</Workbook>`;
  const blob = new Blob([xml], { type: 'application/vnd.ms-excel' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `report-${isoDate(applied.from)}-to-${isoDate(addDays(applied.to, -1))}.xls`;
  a.click();
  URL.revokeObjectURL(url);
}
