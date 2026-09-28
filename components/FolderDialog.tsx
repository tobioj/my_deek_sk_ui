"use client";
// "Add a folder": pick a folder (native dialog or typed path), then either let DeepSeek
// explore it with tools, or tick files to attach directly. Also handles dropped folders.
import clsx from "clsx";
import { AlertTriangle, Compass, FolderOpen, Loader2, Paperclip } from "lucide-react";
import { nanoid } from "nanoid";
import { useMemo, useState } from "react";
import { api, formatBytes, type LocalFile } from "@/lib/client";
import { formatTokens } from "@/lib/tokens";
import type { Attachment, FolderScan } from "@/lib/types";
import { Button, Modal } from "./ui";

const RECENTS_KEY = "recentFolders";
const MAX_ROWS = 1500;

export interface DroppedFolder {
  name: string;
  files: LocalFile[];
}

interface Row {
  path: string;
  size: number;
  skipped?: string;
}

function getRecents(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function rememberFolder(path: string) {
  const next = [path, ...getRecents().filter((p) => p !== path)].slice(0, 6);
  localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
}

interface Props {
  open: boolean;
  onClose: () => void;
  dropped: DroppedFolder | null;
  onAttach: (a: Attachment[]) => void;
  onSetWorkspace: (path: string) => void;
}

// Mounted fresh each time it opens, so it never shows a stale folder.
export function FolderDialog(props: Props) {
  if (!props.open) return null;
  return <FolderDialogBody {...props} />;
}

function FolderDialogBody({ open, onClose, dropped, onAttach, onSetWorkspace }: Props) {
  const [pathInput, setPathInput] = useState("");
  const [scan, setScan] = useState<FolderScan | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(dropped ? dropped.files.filter((f) => !f.skipped).map((f) => f.path) : []),
  );
  const [filter, setFilter] = useState("");
  const [includeMap, setIncludeMap] = useState(true);
  const [recents] = useState<string[]>(getRecents);

  const rows: Row[] = useMemo(() => {
    if (dropped) return dropped.files.map((f) => ({ path: f.path, size: f.size, skipped: f.skipped }));
    return scan?.files.map((f) => ({ path: f.path, size: f.size, skipped: f.skipped })) ?? [];
  }, [dropped, scan]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? rows.filter((r) => r.path.toLowerCase().includes(q)) : rows;
  }, [rows, filter]);

  const selectedBytes = rows.filter((r) => checked.has(r.path)).reduce((n, r) => n + r.size, 0);
  const selectedTokens = Math.ceil(selectedBytes / 4) + (includeMap && scan ? Math.ceil(scan.tree.length / 4) : 0);

  const openPath = async (p: string) => {
    if (!p.trim()) return;
    setBusy("scan");
    setError(null);
    try {
      const result = await api<FolderScan>("/api/folder", { method: "POST", json: { path: p } });
      setScan(result);
      setPathInput(result.root);
      setChecked(new Set(result.files.filter((f) => f.text && !f.skipped).map((f) => f.path)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const browse = async () => {
    setBusy("browse");
    setError(null);
    try {
      const res = await api<{ path?: string; cancelled?: boolean }>("/api/folder/pick", { method: "POST" });
      setBusy(null);
      if (res.path) await openPath(res.path);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };

  const explore = () => {
    if (!scan) return;
    rememberFolder(scan.root);
    onSetWorkspace(scan.root);
    onClose();
  };

  const attach = async () => {
    setBusy("attach");
    setError(null);
    try {
      const out: Attachment[] = [];
      const paths = rows.filter((r) => checked.has(r.path)).map((r) => r.path);
      if (dropped) {
        const byPath = new Map(dropped.files.map((f) => [f.path, f.file]));
        for (const p of paths) {
          const text = await byPath.get(p)!.text();
          if (text.slice(0, 8000).includes("\u0000")) continue;
          out.push({ id: nanoid(10), name: `${dropped.name}/${p}`, kind: "file", size: text.length, content: text });
        }
      } else if (scan) {
        rememberFolder(scan.root);
        if (includeMap) {
          out.push({ id: nanoid(10), name: `${scan.name} (folder map)`, kind: "file", size: scan.tree.length, content: scan.tree });
        }
        const { files } = await api<{ files: { path: string; content: string; truncated: boolean; error?: string }[] }>(
          "/api/folder/read",
          { method: "POST", json: { root: scan.root, paths } },
        );
        for (const f of files) {
          if (f.error) continue;
          out.push({ id: nanoid(10), name: `${scan.name}/${f.path}`, kind: "file", size: f.content.length, content: f.content, truncated: f.truncated });
        }
      }
      onAttach(out);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const toggle = (p: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });

  const reviewing = !!dropped || !!scan;
  const title = dropped ? `Attach from “${dropped.name}”` : scan ? scan.name : "Add a folder";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      width="max-w-2xl"
      footer={
        reviewing && (
          <>
            <span className="mr-auto min-w-0 flex-1 text-[12.5px] leading-snug text-muted">
              {checked.size} file{checked.size === 1 ? "" : "s"} · ~{formatTokens(selectedTokens)} tokens
              {selectedTokens > 300_000 && (
                <span className="block text-warn" title="Attaching this much is slow and costly. Letting DeepSeek explore reads only the files it needs.">
                  Large: exploring is cheaper
                </span>
              )}
            </span>
            <Button variant={scan ? "secondary" : "primary"} onClick={attach} disabled={!!busy || (checked.size === 0 && !(includeMap && scan))}>
              {busy === "attach" ? <Loader2 size={14} className="animate-spin" /> : <Paperclip size={14} />}
              Attach selected
            </Button>
            {scan && (
              <Button variant="primary" onClick={explore} disabled={!!busy}>
                <Compass size={14} /> Let DeepSeek explore it
              </Button>
            )}
          </>
        )
      }
    >
      {!reviewing && (
        <div className="space-y-4">
          <p className="text-[13.5px] leading-relaxed text-muted">
            Choose a folder on your Mac. You can then let DeepSeek <b className="text-fg">explore it on its own</b> (it reads whatever
            files it needs, the way Claude Code does) or <b className="text-fg">attach specific files</b> to your message.
          </p>
          <Button variant="primary" onClick={browse} disabled={!!busy} className="h-10 w-full text-[14px]">
            {busy === "browse" || busy === "scan" ? <Loader2 size={16} className="animate-spin" /> : <FolderOpen size={16} />}
            Choose folder…
          </Button>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              openPath(pathInput);
            }}
            className="flex gap-2"
          >
            <input
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              placeholder="…or type a path, e.g. ~/Documents/Coding/my-app"
              className="h-9 flex-1 rounded-lg border border-line bg-app px-3 font-mono text-[13px] outline-none focus:border-line-strong"
            />
            <Button type="submit" disabled={!pathInput.trim() || !!busy}>
              Open
            </Button>
          </form>
          {recents.length > 0 && (
            <div>
              <div className="mb-1.5 text-xs font-medium text-faint">Recent</div>
              <div className="space-y-0.5">
                {recents.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => openPath(r)}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-hover"
                  >
                    <FolderOpen size={14} className="shrink-0 text-muted" />
                    <span className="font-medium">{r.split("/").pop()}</span>
                    <span className="truncate text-xs text-faint">{r}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {reviewing && (
        <div className="space-y-3">
          {scan && (
            <div className="rounded-xl bg-accent-soft px-3.5 py-2.5 text-[13px] leading-relaxed text-accent">
              <b>Recommended:</b> “Let DeepSeek explore it” gives DeepSeek read-only access to this folder so it opens the files it needs,
              without you picking them. Use “Attach selected” to send specific files with your next message.
            </div>
          )}
          {dropped && (
            <div className="rounded-xl bg-surface-2 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-muted">
              Want DeepSeek to explore this folder itself instead? Use <b>+ → Add a folder…</b> and choose it there — browsers
              don&apos;t reveal a dropped folder&apos;s location.
            </div>
          )}
          {scan?.truncated && (
            <div className="flex items-center gap-2 text-[12.5px] text-warn">
              <AlertTriangle size={14} /> This folder is very large; only the first 5,000 files are listed.
            </div>
          )}
          <div className="flex items-center gap-2">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter files…"
              className="h-8 flex-1 rounded-lg border border-line bg-app px-3 text-[13px] outline-none focus:border-line-strong"
            />
            <Button variant="ghost" onClick={() => setChecked(new Set(visible.filter((r) => !r.skipped).map((r) => r.path)))}>
              Select all
            </Button>
            <Button variant="ghost" onClick={() => setChecked(new Set())}>
              None
            </Button>
          </div>
          {scan && (
            <label className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" checked={includeMap} onChange={(e) => setIncludeMap(e.target.checked)} className="accent-[var(--accent)]" />
              Include the folder map
            </label>
          )}
          <div className="max-h-[45vh] overflow-y-auto rounded-xl border border-line">
            {visible.slice(0, MAX_ROWS).map((r) => {
              const dir = r.path.includes("/") ? r.path.slice(0, r.path.lastIndexOf("/") + 1) : "";
              const base = r.path.slice(dir.length);
              const blocked = r.skipped === "may contain secrets" || r.skipped === "not a text file";
              return (
                <label
                  key={r.path}
                  className={clsx(
                    "flex cursor-pointer items-center gap-2.5 border-b border-line px-3 py-1.5 text-[13px] last:border-0 hover:bg-hover",
                    blocked && "cursor-not-allowed opacity-50",
                  )}
                >
                  <input
                    type="checkbox"
                    disabled={blocked}
                    checked={checked.has(r.path)}
                    onChange={() => toggle(r.path)}
                    className="accent-[var(--accent)]"
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">
                    <span className="text-faint">{dir}</span>
                    {base}
                  </span>
                  {r.skipped && <span className="shrink-0 text-[11px] text-faint">{r.skipped}</span>}
                  <span className="w-16 shrink-0 text-right text-[11.5px] tabular-nums text-faint">{formatBytes(r.size)}</span>
                </label>
              );
            })}
            {visible.length > MAX_ROWS && (
              <div className="px-3 py-2 text-center text-xs text-faint">
                {visible.length - MAX_ROWS} more — use the filter to narrow down
              </div>
            )}
            {visible.length === 0 && <div className="px-3 py-6 text-center text-[13px] text-faint">No files</div>}
          </div>
          {scan && (
            <button type="button" onClick={() => setScan(null)} className="text-[12.5px] text-muted underline-offset-2 hover:underline">
              ← Choose a different folder
            </button>
          )}
        </div>
      )}
      {error && (
        <div className="mt-3 flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}
    </Modal>
  );
}
