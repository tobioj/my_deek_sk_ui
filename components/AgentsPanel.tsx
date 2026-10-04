"use client";
// The Agents panel: the helpers this chat's AI sent to research, live. Each shows what it's doing,
// its time, steps and cost, and opens to its task, steps and report. Stopping helpers here doesn't
// stop the AI's reply, and the chat's Stop button doesn't stop helpers.
import clsx from "clsx";
import { AlertTriangle, CheckCircle2, ChevronRight, Clock, Loader2, Square, UsersRound, X } from "lucide-react";
import { createContext, useEffect, useState } from "react";
import { formatCost } from "@/lib/tokens";
import type { HelperRun } from "@/lib/types";
import { Markdown } from "./Markdown";

// Lets a helper card in the chat open the panel.
export const AgentsPanelContext = createContext<(() => void) | null>(null);

export interface HelperState {
  runs: HelperRun[];
  running: number;
  waiting: number; // reports whose whole round has finished, not yet with the AI
  ready: boolean;
  paused: boolean; // waiting, but the AI already replied automatically 3 times in a row
}

const took = (from: string, to: number) => {
  const s = Math.max(0, Math.round((to - Date.parse(from)) / 1000));
  return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
};

function StatusPill({ run, now }: { run: HelperRun; now: number }) {
  const time = took(run.startedAt, run.endedAt ? Date.parse(run.endedAt) : now);
  const [label, cls, Icon] =
    run.status === "running"
      ? ["Working", "text-accent", Loader2]
      : run.status === "done"
        ? ["Done", "text-green-600 dark:text-green-400", CheckCircle2]
        : run.status === "limit"
          ? [run.limit === "time" ? "Ran out of time" : "Ran out of steps", "text-warn", Clock]
          : run.status === "stopped"
            ? [run.stoppedBy === "brain" ? "Stopped by the AI" : run.stoppedBy === "app" ? "Stopped (app closed)" : "Stopped", "text-muted", Square]
            : ["Failed", "text-danger", AlertTriangle];
  return (
    <span className={clsx("inline-flex shrink-0 items-center gap-1 text-[11.5px] font-medium", cls)}>
      <Icon size={12} className={run.status === "running" ? "animate-spin" : ""} /> {label} · {time}
    </span>
  );
}

function HelperCard({ run, now, onStop }: { run: HelperRun; now: number; onStop: () => void }) {
  const [open, setOpen] = useState(false);
  const running = run.status === "running";
  return (
    <div className="rounded-xl border border-line bg-app">
      <div className="flex items-start gap-2 px-3 py-2.5">
        <button type="button" onClick={() => setOpen((o) => !o)} className="min-w-0 flex-1 text-left" aria-expanded={open}>
          <div className="flex items-center gap-1.5">
            <ChevronRight size={13} className={clsx("shrink-0 text-faint transition-transform", open && "rotate-90")} />
            <span className="truncate text-[13px] font-medium">{run.title}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-5">
            <StatusPill run={run} now={now} />
            <span className="text-[11.5px] text-faint">
              {run.steps.length} step{run.steps.length === 1 ? "" : "s"} · {formatCost(run.cost)}
            </span>
          </div>
          {running && run.activity && <div className="mt-1 truncate pl-5 text-[11.5px] text-muted">{run.activity}</div>}
        </button>
        {running && (
          <button
            type="button"
            onClick={onStop}
            title="Stop this helper (the AI's reply keeps going)"
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-line px-2 text-[12px] text-muted hover:bg-hover hover:text-fg"
          >
            <Square size={11} /> Stop
          </button>
        )}
      </div>
      {open && (
        <div className="space-y-3 border-t border-line px-3 py-2.5 text-[12.5px]">
          <div>
            <div className="mb-1 font-medium text-muted">Task</div>
            <div className="max-h-40 overflow-y-auto whitespace-pre-wrap text-fg/90">{run.task}</div>
          </div>
          {run.steps.length > 0 && (
            <div>
              <div className="mb-1 font-medium text-muted">What it did</div>
              <ol className="max-h-48 space-y-0.5 overflow-y-auto">
                {run.steps.map((s, i) => (
                  <li key={i} className={clsx("truncate", s.ok ? "text-muted" : "text-danger")} title={s.summary}>
                    {i + 1}. {s.summary}
                  </li>
                ))}
              </ol>
            </div>
          )}
          {!running && (
            <div>
              <div className="mb-1 font-medium text-muted">Report{run.delivered ? " (with the AI)" : ""}</div>
              <div className="max-h-96 overflow-y-auto text-[13px]">
                <Markdown text={run.report || run.error || "(no report)"} />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function AgentsPanel({
  state,
  ai,
  onStop,
  onClose,
}: {
  state: HelperState | null;
  ai: string;
  onStop: (ids: "all" | string[]) => void;
  onClose: () => void;
}) {
  const runs = state?.runs ?? [];
  const running = runs.filter((r) => r.status === "running").length;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  const cost = runs.reduce((n, r) => n + r.cost, 0);
  return (
    <aside className="flex h-full w-[360px] max-w-[90vw] shrink-0 flex-col border-l border-line bg-surface max-md:fixed max-md:inset-y-0 max-md:right-0 max-md:z-40 max-md:shadow-xl">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <UsersRound size={15} className="text-muted" />
        <div className="flex-1 text-[14px] font-semibold">Helpers</div>
        {running > 0 && (
          <button
            type="button"
            onClick={() => onStop("all")}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-line px-2 text-[12px] text-muted hover:bg-hover hover:text-fg"
          >
            <Square size={11} /> Stop all
          </button>
        )}
        <button type="button" onClick={onClose} aria-label="Close the helpers panel" className="rounded-md p-1 text-muted hover:bg-hover hover:text-fg">
          <X size={16} />
        </button>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {!runs.length ? (
          <p className="text-[12.5px] text-muted">
            No helpers yet. Switch on <b>Helpers</b> by the message box and give {ai} a task that splits into parts: it sends helpers to research
            them and acts on their reports.
          </p>
        ) : (
          [...runs].reverse().map((r) => <HelperCard key={r.id} run={r} now={now} onStop={() => onStop([r.id])} />)
        )}
      </div>
      {runs.length > 0 && (
        <div className="border-t border-line px-3 py-2 text-[11.5px] text-faint">
          {running ? `${running} working · ` : ""}
          {runs.length} helper{runs.length === 1 ? "" : "s"} in this chat · {formatCost(cost)}
          {state?.waiting ? ` · ${state.waiting} report${state.waiting === 1 ? "" : "s"} waiting for ${ai}` : ""}
        </div>
      )}
    </aside>
  );
}
