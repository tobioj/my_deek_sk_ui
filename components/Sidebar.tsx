"use client";
import clsx from "clsx";
import {
  ChevronRight,
  Download,
  FolderInput,
  FolderMinus,
  FolderOpen,
  Layers,
  MoreHorizontal,
  PanelLeftClose,
  Pencil,
  Plus,
  Search,
  Settings as SettingsIcon,
  SlidersHorizontal,
  SquarePen,
  Trash2,
} from "lucide-react";
import { forwardRef, useState } from "react";
import type { ChatSummary, ProjectSummary } from "@/lib/types";
import { IconButton, MenuItem, Popover } from "./ui";

function groupLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = d.getTime();
  if (t >= startOfToday) return "Today";
  if (t >= startOfToday - 86400000) return "Yesterday";
  if (t >= startOfToday - 7 * 86400000) return "Previous 7 days";
  if (t >= startOfToday - 30 * 86400000) return "Previous 30 days";
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

export const Sidebar = forwardRef<
  HTMLInputElement,
  {
    chats: ChatSummary[];
    activeId: string | null;
    streamingIds: Set<string>; // chats replying right now
    waitingIds: Set<string>; // chats waiting for you to approve a change or command
    search: string;
    onSearch: (q: string) => void;
    onSelect: (id: string) => void;
    onNew: () => void;
    onRename: (id: string, title: string) => void;
    onDelete: (id: string) => void;
    onCollapse: () => void;
    onSettings: () => void;
    keyMissing: boolean;
    projects: ProjectSummary[];
    activeProjectId: string | null; // project of the open chat (or of the new chat being drafted)
    expanded: Set<string>;
    onToggleProject: (id: string) => void;
    onNewProject: () => void;
    onEditProject: (id: string) => void;
    onNewChatInProject: (id: string) => void;
    onMoveChat: (chatId: string, projectId: string | null) => void;
  }
>(function Sidebar(p, searchRef) {
  const projectIds = new Set(p.projects.map((x) => x.id));
  const searching = p.search.trim().length > 0;
  const inProject = (c: ChatSummary) => !!c.projectId && projectIds.has(c.projectId);
  const loose = searching ? p.chats : p.chats.filter((c) => !inProject(c));
  const projectName = (id?: string | null) => p.projects.find((x) => x.id === id)?.name;
  const rowProps = (c: ChatSummary) => ({
    chat: c,
    active: c.id === p.activeId,
    streaming: p.streamingIds.has(c.id),
    waiting: p.waitingIds.has(c.id),
    projects: p.projects,
    onSelect: () => p.onSelect(c.id),
    onRename: (t: string) => p.onRename(c.id, t),
    onDelete: () => p.onDelete(c.id),
    onMove: (projectId: string | null) => p.onMoveChat(c.id, projectId),
  });

  const groups: { label: string; chats: ChatSummary[] }[] = [];
  for (const c of loose) {
    const label = groupLabel(c.updatedAt);
    const g = groups[groups.length - 1];
    if (g && g.label === label) g.chats.push(c);
    else groups.push({ label, chats: [c] });
  }

  return (
    <aside className="flex h-full w-[272px] shrink-0 flex-col border-r border-line bg-sidebar">
      <div className="flex h-13 items-center justify-between px-3 pt-1">
        <div className="flex items-center gap-2 pl-1">
          <Logo />
          <span className="text-[15px] font-semibold tracking-tight">DeepSeek</span>
        </div>
        <IconButton label="Hide sidebar (⌘B)" onClick={p.onCollapse}>
          <PanelLeftClose size={17} />
        </IconButton>
      </div>

      <div className="space-y-1 px-2 pt-1">
        <button
          type="button"
          onClick={p.onNew}
          className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px] font-medium hover:bg-hover"
        >
          <SquarePen size={16} className="text-accent" />
          New chat
          <span className="ml-auto text-[11px] font-normal text-faint">⌘⇧O</span>
        </button>
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
          <input
            ref={searchRef}
            value={p.search}
            onChange={(e) => p.onSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && (p.onSearch(""), (e.target as HTMLInputElement).blur())}
            placeholder="Search chats"
            className="h-8 w-full rounded-lg bg-transparent pl-8 pr-10 text-[13px] outline-none placeholder:text-faint hover:bg-hover focus:bg-surface focus:ring-1 focus:ring-line-strong"
          />
          <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-faint">⌘K</span>
        </div>
      </div>

      <nav className="mt-2 min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {!searching && (
          <div className="mb-3">
            <div className="group/h flex items-center justify-between px-2.5 pb-1 pt-2">
              <span className="text-[11.5px] font-medium text-faint">Projects</span>
              <button
                type="button"
                onClick={p.onNewProject}
                title="New project"
                aria-label="New project"
                className="flex h-5 w-5 items-center justify-center rounded text-faint hover:bg-hover hover:text-fg"
              >
                <Plus size={13} />
              </button>
            </div>
            {p.projects.length === 0 && (
              <button
                type="button"
                onClick={p.onNewProject}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-faint hover:bg-hover hover:text-fg"
              >
                <Layers size={14} /> Group chats that share context
              </button>
            )}
            {p.projects.map((proj) => {
              const open = p.expanded.has(proj.id);
              const chats = p.chats.filter((c) => c.projectId === proj.id);
              // A folded project still shows that one of its chats is replying or waiting for you.
              const waiting = !open && chats.some((c) => p.waitingIds.has(c.id));
              const replying = !open && chats.some((c) => p.streamingIds.has(c.id));
              return (
                <div key={proj.id}>
                  <div className="group relative">
                    <button
                      type="button"
                      onClick={() => p.onToggleProject(proj.id)}
                      className={clsx(
                        "flex h-8 w-full items-center gap-1.5 rounded-lg pl-1.5 pr-14 text-left text-[13.5px] hover:bg-hover",
                        p.activeProjectId === proj.id && !open && "bg-hover",
                      )}
                      title={proj.folders.length ? `${proj.name}\n${proj.folders.map((f) => `📁 ${f}`).join("\n")}` : proj.name}
                    >
                      <ChevronRight size={14} className={clsx("shrink-0 text-faint transition-transform", open && "rotate-90")} />
                      <Layers size={14} className="shrink-0 text-accent" />
                      <span className="truncate font-medium">{proj.name}</span>
                      {(waiting || replying) && <ActivityDot waiting={waiting} />}
                      {chats.length > 0 && !open && <span className="ml-auto shrink-0 text-[11px] text-faint">{chats.length}</span>}
                    </button>
                    <div className="absolute right-1 top-1 hidden gap-0.5 group-hover:flex">
                      <button
                        type="button"
                        onClick={() => p.onNewChatInProject(proj.id)}
                        title="New chat in this project"
                        aria-label={`New chat in ${proj.name}`}
                        className="flex h-6 w-6 items-center justify-center rounded-md text-muted hover:bg-line hover:text-fg"
                      >
                        <SquarePen size={13} />
                      </button>
                      <button
                        type="button"
                        onClick={() => p.onEditProject(proj.id)}
                        title="Project settings"
                        aria-label={`${proj.name} settings`}
                        className="flex h-6 w-6 items-center justify-center rounded-md text-muted hover:bg-line hover:text-fg"
                      >
                        <SlidersHorizontal size={13} />
                      </button>
                    </div>
                  </div>
                  {open && (
                    <div className="ml-3.5 border-l border-line pl-1.5">
                      <button
                        type="button"
                        onClick={() => p.onNewChatInProject(proj.id)}
                        className={clsx(
                          "flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] text-muted hover:bg-hover hover:text-fg",
                          p.activeProjectId === proj.id && !p.activeId && "bg-hover text-fg",
                        )}
                      >
                        <Plus size={13} /> New chat
                      </button>
                      {chats.map((c) => (
                        <ChatRow key={c.id} {...rowProps(c)} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {groups.map((g) => (
          <div key={g.label} className="mb-3">
            <div className="px-2.5 pb-1 pt-2 text-[11.5px] font-medium text-faint">{g.label}</div>
            {g.chats.map((c) => (
              <ChatRow key={c.id} {...rowProps(c)} tag={searching ? projectName(c.projectId) : undefined} />
            ))}
          </div>
        ))}
        {p.chats.length === 0 && (
          <div className="px-3 py-8 text-center text-[12.5px] text-faint">{p.search ? "No chats match." : "Your chats will show up here."}</div>
        )}
      </nav>

      <div className="border-t border-line p-2">
        <button
          type="button"
          onClick={p.onSettings}
          className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px] hover:bg-hover"
        >
          <SettingsIcon size={16} className="text-muted" />
          Settings
          {p.keyMissing && <span className="ml-auto rounded-full bg-danger-soft px-2 py-0.5 text-[11px] font-medium text-danger">Add API key</span>}
        </button>
      </div>
    </aside>
  );
});

// Replying (pulsing blue) or waiting for your approval (amber).
function ActivityDot({ waiting }: { waiting: boolean }) {
  return waiting ? (
    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" title="Waiting for you to approve something" />
  ) : (
    <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" title="Replying" />
  );
}

function ChatRow({
  chat,
  active,
  streaming,
  waiting,
  projects,
  tag,
  onSelect,
  onRename,
  onDelete,
  onMove,
}: {
  chat: ChatSummary;
  active: boolean;
  streaming: boolean;
  waiting: boolean;
  projects: ProjectSummary[];
  tag?: string;
  onSelect: () => void;
  onRename: (t: string) => void;
  onDelete: () => void;
  onMove: (projectId: string | null) => void;
}) {
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [title, setTitle] = useState(chat.title);

  if (renaming) {
    return (
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={() => {
          setRenaming(false);
          if (title.trim() && title !== chat.title) onRename(title.trim());
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setTitle(chat.title);
            setRenaming(false);
          }
        }}
        className="h-8 w-full rounded-lg border border-line-strong bg-surface px-2.5 text-[13.5px] outline-none"
      />
    );
  }

  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onSelect}
        onDoubleClick={() => {
          setTitle(chat.title);
          setRenaming(true);
        }}
        className={clsx(
          "flex h-8 w-full items-center gap-2 rounded-lg px-2.5 pr-8 text-left text-[13.5px]",
          active ? "bg-hover font-medium text-fg" : "text-fg/85 hover:bg-hover",
        )}
        title={chat.folders.length ? `${chat.title}\n${chat.folders.map((f) => `📁 ${f}`).join("\n")}` : chat.title}
      >
        {(streaming || waiting) && <ActivityDot waiting={waiting} />}
        <span className="truncate">{chat.title}</span>
        {waiting && <span className="shrink-0 text-[10.5px] font-medium text-warn">waiting</span>}
        {tag && <span className="shrink-0 rounded bg-surface-2 px-1.5 text-[10.5px] text-muted">{tag}</span>}
        {chat.folders.length > 0 && <FolderOpen size={12} className="shrink-0 text-faint" />}
      </button>
      <button
        type="button"
        aria-label="Chat options"
        onClick={() => {
          setConfirmDelete(false);
          setMenu((m) => !m);
        }}
        className={clsx(
          "absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-md text-muted hover:bg-line hover:text-fg",
          menu ? "flex" : "hidden group-hover:flex",
        )}
      >
        <MoreHorizontal size={15} />
      </button>
      <Popover open={menu} onClose={() => setMenu(false)} className="right-0 top-8 w-52">
        <MenuItem
          icon={<Pencil size={14} />}
          onClick={() => {
            setMenu(false);
            setTitle(chat.title);
            setRenaming(true);
          }}
        >
          Rename
        </MenuItem>
        <MenuItem
          icon={<Download size={14} />}
          onClick={() => {
            setMenu(false);
            const link = document.createElement("a");
            link.href = `/api/chats/${chat.id}/export`;
            link.download = "";
            link.click();
          }}
        >
          Export Markdown
        </MenuItem>
        {projects.filter((pr) => pr.id !== chat.projectId).length > 0 && (
          <>
            <div className="mx-2 my-1 border-t border-line" />
            <div className="px-2.5 pb-0.5 pt-1 text-[11px] font-medium text-faint">Move to project</div>
            {projects
              .filter((pr) => pr.id !== chat.projectId)
              .map((pr) => (
                <MenuItem
                  key={pr.id}
                  icon={<FolderInput size={14} />}
                  onClick={() => {
                    setMenu(false);
                    onMove(pr.id);
                  }}
                >
                  <span className="block max-w-36 truncate">{pr.name}</span>
                </MenuItem>
              ))}
          </>
        )}
        {chat.projectId && projects.some((pr) => pr.id === chat.projectId) && (
          <MenuItem
            icon={<FolderMinus size={14} />}
            onClick={() => {
              setMenu(false);
              onMove(null);
            }}
          >
            Remove from project
          </MenuItem>
        )}
        <div className="mx-2 my-1 border-t border-line" />
        <MenuItem
          icon={<Trash2 size={14} />}
          danger
          onClick={() => {
            if (!confirmDelete) return setConfirmDelete(true);
            setMenu(false);
            onDelete();
          }}
        >
          {confirmDelete ? "Click again to delete" : "Delete"}
        </MenuItem>
      </Popover>
    </div>
  );
}

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--accent)" />
      <path
        d="M8 17.5c0-4.7 3.6-8.5 8.3-8.5 3.3 0 6 1.8 7.4 4.5.3.6 1.2.7 1.7.2l.9-.9c.4-.4 1.1 0 1 .6-.6 3.6-2.6 6.4-5.3 7.8.7 1 1.8 1.7 3 1.9.5.1.6.7.2 1-1.4.9-3.1 1.2-4.8.8-1.2.3-2.4.5-3.7.5C12 25.4 8 22 8 17.5Z"
        fill="#fff"
      />
      <circle cx="19.6" cy="14.6" r="1.3" fill="var(--accent)" />
    </svg>
  );
}
