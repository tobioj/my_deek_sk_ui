"use client";
// The whole app: sidebar, conversation, composer, dialogs, drag-and-drop.
import clsx from "clsx";
import { ArrowDown, FolderOpen, KeyRound, Layers, PanelLeftOpen, Paperclip, Settings as SettingsIcon, SlidersHorizontal, SquarePen, Upload } from "lucide-react";
import { nanoid } from "nanoid";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api, fileToAttachment, readEvents, walkDroppedFolder, type DraftAttachment, type LocalFile } from "@/lib/client";
import { estimateTokens } from "@/lib/tokens";
import type {
  AssistantMessage,
  Attachment,
  Chat,
  ChatMessage,
  ChatSummary,
  Effort,
  KeyStatus,
  Mode,
  ModelId,
  Project,
  ProjectSummary,
  Settings,
  UserMessage,
} from "@/lib/types";
import { isEditingMode } from "@/lib/types";
import { linkedFolders, ownFolders, projectFolders } from "@/lib/folders";
import { Composer } from "./Composer";
import { FolderDialog, rememberFolder, type DroppedFolder } from "./FolderDialog";
import { AssistantBlock, UserBubble } from "./Message";
import { ProjectDialog } from "./ProjectDialog";
import { SettingsDialog } from "./SettingsDialog";
import { Logo, Sidebar } from "./Sidebar";
import { Button, IconButton } from "./ui";

type Prefs = {
  model: ModelId;
  thinking: boolean;
  effort: Effort;
  folders: string[]; // the chat's own folders
  hiddenProjectFolders: string[]; // project folders switched off for this chat
  webSearch: boolean;
  github: boolean;
  mode: Mode;
  autoApprove: boolean;
  projectId: string | null;
};
const EXPANDED_KEY = "expandedProjects";
type Draft = { text: string; attachments: DraftAttachment[] };

const cloneAssistant = (a: AssistantMessage): AssistantMessage => ({
  ...a,
  usage: a.usage ? { ...a.usage } : undefined,
  steps: a.steps.map((s) => ({ ...s, toolCalls: s.toolCalls?.map((c) => ({ ...c })) })),
});

function chatIdFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get("c");
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Burning the midnight oil?";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export function ChatApp() {
  // True only in the browser (the app relies on localStorage, the clock and window.location).
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [search, setSearch] = useState("");
  const [chat, setChat] = useState<Chat | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [keyStatus, setKeyStatus] = useState<KeyStatus | null>(null);
  const [searchKey, setSearchKey] = useState<KeyStatus | null>(null);
  const [githubKey, setGithubKey] = useState<KeyStatus | null>(null);
  const [defaultSystemPrompt, setDefaultSystemPrompt] = useState("");
  const [draftPrefs, setDraftPrefs] = useState<Prefs>({
    model: "deepseek-flash",
    thinking: true,
    effort: "high",
    folders: [],
    hiddenProjectFolders: [],
    webSearch: false,
    github: false,
    mode: "ask",
    autoApprove: false,
    projectId: null,
  });
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? "[]"));
    } catch {
      return new Set();
    }
  });
  const [projectDialog, setProjectDialog] = useState<{ open: boolean; project: Project | null }>({ open: false, project: null });
  const [activeProject, setActiveProject] = useState<Project | null>(null); // full details of the current chat's project
  const [gitChanged, setGitChanged] = useState(0);
  const [gitCheck, setGitCheck] = useState(0); // bump to re-check Git status
  const [live, setLive] = useState<{ chatId: string; assistant: AssistantMessage } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(() => typeof window === "undefined" || window.innerWidth >= 900);
  const narrow = useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia("(max-width: 767px)");
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => window.matchMedia("(max-width: 767px)").matches,
    () => false,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const [dropped, setDropped] = useState<DroppedFolder | null>(null);
  const [dragging, setDragging] = useState(false);
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [atBottom, setAtBottom] = useState(true);

  const abortRef = useRef<AbortController | null>(null);
  const chatRef = useRef<Chat | null>(null);
  const draftPrefsRef = useRef(draftPrefs);
  const drafts = useRef(new Map<string, Draft>());
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    chatRef.current = chat;
  }, [chat]);
  useEffect(() => {
    draftPrefsRef.current = draftPrefs;
  }, [draftPrefs]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 4500);
  }, []);

  // ---------- Loading ----------

  const refreshChats = useCallback(async (q?: string) => {
    try {
      const query = q ?? "";
      setChats(await api<ChatSummary[]>(`/api/chats${query ? `?q=${encodeURIComponent(query)}` : ""}`));
    } catch {}
  }, []);

  const refreshProjects = useCallback(async () => {
    try {
      setProjects(await api<ProjectSummary[]>("/api/projects"));
    } catch {}
  }, []);

  const loadSettings = useCallback(async () => {
    const data = await api<{ settings: Settings; key: KeyStatus; searchKey: KeyStatus; githubKey: KeyStatus; defaultSystemPrompt: string }>(
      "/api/settings",
    );
    setSettings(data.settings);
    setKeyStatus(data.key);
    setSearchKey(data.searchKey);
    setGithubKey(data.githubKey);
    setDefaultSystemPrompt(data.defaultSystemPrompt);
    return data;
  }, []);

  const saveDraft = useCallback(() => {
    const key = chatRef.current?.id ?? (draftPrefsRef.current.projectId ? `new:${draftPrefsRef.current.projectId}` : "new");
    drafts.current.set(key, { text, attachments });
  }, [text, attachments]);

  const restoreDraft = useCallback((key: string) => {
    const d = drafts.current.get(key);
    setText(d?.text ?? "");
    setAttachments(d?.attachments ?? []);
  }, []);

  const loadChat = useCallback(
    async (id: string) => {
      try {
        const c = await api<Chat>(`/api/chats/${id}`);
        setChat(c);
        restoreDraft(c.id);
        stickRef.current = true;
      } catch {
        setChat(null);
        window.history.replaceState(null, "", "/");
        showToast("That chat couldn't be found.");
      }
    },
    [restoreDraft, showToast],
  );

  useEffect(() => {
    api<{ settings: Settings; key: KeyStatus; searchKey: KeyStatus; githubKey: KeyStatus; defaultSystemPrompt: string }>("/api/settings")
      .then((data) => {
        setSettings(data.settings);
        setKeyStatus(data.key);
        setSearchKey(data.searchKey);
        setGithubKey(data.githubKey);
        setDefaultSystemPrompt(data.defaultSystemPrompt);
        const s = data.settings;
        setDraftPrefs((p) => ({ ...p, model: s.defaultModel, thinking: s.thinking, effort: s.effort }));
      })
      .catch(() => showToast("Couldn't load settings."));
    api<ProjectSummary[]>("/api/projects")
      .then(setProjects)
      .catch(() => {});
    const id = chatIdFromUrl();
    if (id) {
      api<Chat>(`/api/chats/${id}`)
        .then(setChat)
        .catch(() => window.history.replaceState(null, "", "/"));
    }
    const onPop = () => {
      const pid = chatIdFromUrl();
      if (pid) loadChat(pid);
      else setChat(null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [loadChat, showToast]);

  // Search as you type.
  useEffect(() => {
    const t = setTimeout(() => refreshChats(search), 150);
    return () => clearTimeout(t);
  }, [search, refreshChats]);

  // ---------- Navigation ----------

  const selectChat = (id: string) => {
    if (narrow) setSidebarOpen(false);
    if (id === chat?.id) return;
    saveDraft();
    window.history.pushState(null, "", `/?c=${id}`);
    loadChat(id);
  };

  const newChat = useCallback(
    (projectId: string | null = null) => {
      if (window.matchMedia("(max-width: 767px)").matches) setSidebarOpen(false);
      saveDraft();
      setChat(null);
      window.history.pushState(null, "", "/");
      restoreDraft(projectId ? `new:${projectId}` : "new");
      setDraftPrefs((p) => ({
        model: settings?.defaultModel ?? p.model,
        thinking: settings?.thinking ?? p.thinking,
        effort: settings?.effort ?? p.effort,
        folders: [], // project folders are linked automatically
        hiddenProjectFolders: [],
        webSearch: false,
        github: false,
        mode: "ask",
        autoApprove: false,
        projectId: projectId,
      }));
      if (projectId) {
        setExpanded((prev) => {
          const next = new Set(prev).add(projectId);
          localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]));
          return next;
        });
      }
    },
    [saveDraft, restoreDraft, settings],
  );

  const renameChat = async (id: string, title: string) => {
    setChats((list) => list.map((c) => (c.id === id ? { ...c, title } : c)));
    if (chat?.id === id) setChat({ ...chat, title });
    await api(`/api/chats/${id}`, { method: "PATCH", json: { title } }).catch((e) => showToast(e.message));
  };

  const deleteChat = async (id: string) => {
    if (live?.chatId === id) abortRef.current?.abort();
    setChats((list) => list.filter((c) => c.id !== id));
    if (chat?.id === id) {
      setChat(null);
      window.history.pushState(null, "", "/");
      restoreDraft("new");
    }
    drafts.current.delete(id);
    await api(`/api/chats/${id}`, { method: "DELETE" }).catch((e) => showToast(e.message));
  };

  // ---------- Preferences (model, thinking, project folder) ----------

  const prefs: Prefs = chat
    ? {
        model: chat.model,
        thinking: chat.thinking,
        effort: chat.effort,
        folders: ownFolders(chat),
        hiddenProjectFolders: chat.hiddenProjectFolders ?? [],
        webSearch: !!chat.webSearch,
        github: !!chat.github,
        mode: chat.mode === "edit" && chat.autoApprove ? "auto" : (chat.mode ?? "ask"),
        autoApprove: !!chat.autoApprove,
        projectId: chat.projectId ?? null,
      }
    : draftPrefs;

  // The current chat's project, and every folder DeepSeek can use here.
  const currentProjectId = chat ? chat.projectId ?? null : draftPrefs.projectId;
  const project = currentProjectId && activeProject?.id === currentProjectId ? activeProject : null;
  const linked = useMemo(
    () => linkedFolders(prefs.folders, prefs.projectId ? projectFolders(project) : [], prefs.hiddenProjectFolders),
    [prefs.folders, prefs.projectId, prefs.hiddenProjectFolders, project],
  );
  const activeFolders = linked.filter((f) => !f.hidden);
  const activeKey = activeFolders.map((f) => f.path).join("|");

  // GitHub button: hidden until set up; in a project, it needs repos picked for that project.
  const githubState: "hidden" | "ready" | "no-repos" = (() => {
    const allow = settings?.githubRepos ?? [];
    if (!githubKey?.configured || !allow.length) return "hidden";
    if (!prefs.projectId) return "ready";
    if (!project) return "ready";
    const chosen = (project.githubRepos ?? []).map((r) => r.toLowerCase());
    return allow.some((r) => chosen.includes(r.toLowerCase())) ? "ready" : "no-repos";
  })();

  const updatePrefs = async (patch: Partial<Prefs>) => {
    if (patch.webSearch && !searchKey?.configured) {
      showToast("Add your free Tavily key to use web search.");
      setSettingsOpen(true);
      return;
    }
    const current = chatRef.current;
    if (!current) {
      setDraftPrefs((p) => ({ ...p, ...patch }));
      return;
    }
    setChat({ ...current, ...patch });
    try {
      const saved = await api<Chat>(`/api/chats/${current.id}`, { method: "PATCH", json: patch });
      setChat((c) =>
        c && c.id === saved.id
          ? {
              ...c,
              model: saved.model,
              thinking: saved.thinking,
              effort: saved.effort,
              folders: saved.folders,
              workspace: saved.workspace,
              hiddenProjectFolders: saved.hiddenProjectFolders,
              webSearch: saved.webSearch,
              github: saved.github,
              mode: saved.mode,
              autoApprove: saved.autoApprove,
              projectId: saved.projectId,
            }
          : c,
      );
      if ("folders" in patch || "projectId" in patch) refreshChats(search);
    } catch (e) {
      setChat((c) => (c && c.id === current.id ? { ...c, ...current, messages: c.messages } : c));
      showToast((e as Error).message);
    }
  };

  // ---------- Attachments ----------

  const addFiles = useCallback(
    (files: File[]) => {
      for (const file of files) {
        const id = nanoid(10);
        setAttachments((prev) => [...prev, { id, name: file.name, kind: "file", size: file.size, status: "loading" }]);
        fileToAttachment(file)
          .then((a) => setAttachments((prev) => prev.map((x) => (x.id === id ? { ...a, id, status: "ready" } : x))))
          .catch((e: Error) => {
            setAttachments((prev) => prev.map((x) => (x.id === id ? { ...x, status: "error", error: e.message } : x)));
            setTimeout(() => setAttachments((prev) => prev.filter((x) => x.id !== id)), 6000);
          });
      }
    },
    [],
  );

  const addReadyAttachments = (list: Attachment[]) => {
    setAttachments((prev) => [...prev, ...list.map((a) => ({ ...a, status: "ready" as const }))]);
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const plain: File[] = [];
    const dirs: FileSystemDirectoryEntry[] = [];
    for (const item of Array.from(e.dataTransfer.items)) {
      if (item.kind !== "file") continue;
      const entry = item.webkitGetAsEntry?.();
      if (entry?.isDirectory) dirs.push(entry as FileSystemDirectoryEntry);
      else {
        const f = item.getAsFile();
        if (f) plain.push(f);
      }
    }
    if (plain.length) addFiles(plain);
    if (dirs.length) {
      try {
        let files: LocalFile[] = [];
        for (const d of dirs) {
          const list = await walkDroppedFolder(d);
          files = files.concat(dirs.length > 1 ? list.map((f) => ({ ...f, path: `${d.name}/${f.path}` })) : list);
        }
        setDropped({ name: dirs.length > 1 ? `${dirs.length} folders` : dirs[0].name, files });
        setFolderOpen(true);
      } catch {
        showToast("Couldn't read that folder.");
      }
    }
  };

  // ---------- Sending & streaming ----------

  const stream = async (chatId: string, body: Record<string, unknown>, optimisticId?: string) => {
    const ac = new AbortController();
    abortRef.current = ac;
    stickRef.current = true;
    const model = chatRef.current?.id === chatId ? chatRef.current.model : draftPrefsRef.current.model;
    const a: AssistantMessage = { id: `live-${nanoid(8)}`, role: "assistant", createdAt: new Date().toISOString(), model, steps: [] };
    const cur = () => {
      if (!a.steps.length) a.steps.push({ content: "" });
      return a.steps[a.steps.length - 1];
    };
    let frame = 0;
    const flush = () => {
      frame = 0;
      setLive({ chatId, assistant: cloneAssistant(a) });
    };
    setLive({ chatId, assistant: cloneAssistant(a) });

    let final: AssistantMessage | null = null;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId, ...body }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        const d = await res.json().catch(() => ({}));
        throw new Error((d as { error?: string }).error || `Request failed (${res.status})`);
      }
      for await (const ev of readEvents(res.body)) {
        switch (ev.type) {
          case "user":
            setChat((c) =>
              c && c.id === chatId ? { ...c, messages: c.messages.map((m) => (m.id === optimisticId ? ev.message : m)) } : c,
            );
            break;
          case "start":
            a.id = ev.id;
            a.model = ev.model;
            break;
          case "step":
            a.steps.push({ content: "" });
            break;
          case "reasoning":
            cur().reasoning = (cur().reasoning ?? "") + ev.delta;
            break;
          case "text":
            cur().content += ev.delta;
            break;
          case "tool_call":
            (cur().toolCalls ??= []).push(ev.call);
            break;
          case "approval":
            for (const s of a.steps) {
              const call = s.toolCalls?.find((c) => c.id === ev.id);
              if (call) Object.assign(call, { diff: ev.diff, status: "pending" });
            }
            break;
          case "tool_result":
            for (const s of a.steps) {
              const call = s.toolCalls?.find((c) => c.id === ev.id);
              if (call) Object.assign(call, { summary: ev.summary, ok: ev.ok, sources: ev.sources, diff: ev.diff ?? call.diff, status: ev.status });
            }
            break;
          case "ping":
            break;
          case "usage":
            a.usage = ev.usage;
            a.contextTokens = ev.contextTokens;
            break;
          case "title":
            setChats((list) => list.map((c) => (c.id === chatId ? { ...c, title: ev.title } : c)));
            setChat((c) => (c && c.id === chatId ? { ...c, title: ev.title } : c));
            break;
          case "error":
            a.error = ev.message;
            break;
          case "done":
            final = ev.message;
            break;
        }
        if (!frame) frame = requestAnimationFrame(flush);
      }
    } catch (err) {
      if (ac.signal.aborted) a.stopped = true;
      else a.error = (err as Error).message || "The connection was interrupted.";
    }
    cancelAnimationFrame(frame);
    const result: AssistantMessage = final ?? {
      ...cloneAssistant(a),
      steps: a.steps.filter((s) => s.content || s.reasoning || s.toolCalls?.length),
    };
    setChat((c) => (c && c.id === chatId ? { ...c, messages: [...c.messages, result] } : c));
    setLive((l) => (l?.chatId === chatId ? null : l));
    if (abortRef.current === ac) abortRef.current = null;
    refreshChats(search);
    if (result.error && /api key/i.test(result.error)) loadSettings().catch(() => {});
  };

  const send = async () => {
    if (live) return;
    const ready = attachments.filter((a) => a.status === "ready");
    const body = {
      text: text.trim(),
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      attachments: ready.map(({ status, error, ...a }) => a),
    };
    if (!body.text && !body.attachments.length) return;

    let target = chatRef.current;
    if (!target) {
      try {
        target = await api<Chat>("/api/chats", { method: "POST", json: draftPrefs });
      } catch (e) {
        showToast((e as Error).message);
        return;
      }
      drafts.current.delete(draftPrefs.projectId ? `new:${draftPrefs.projectId}` : "new");
      window.history.pushState(null, "", `/?c=${target.id}`);
      setChats((list) => [
        { id: target!.id, title: target!.title, updatedAt: target!.updatedAt, folders: target!.folders ?? [], projectId: target!.projectId, cost: 0 },
        ...list,
      ]);
    }
    const optimistic: UserMessage = {
      id: `tmp-${nanoid(8)}`,
      role: "user",
      createdAt: new Date().toISOString(),
      text: body.text,
      attachments: ready.map((a) => ({ id: a.id, name: a.name, kind: a.kind, size: a.size, truncated: a.truncated, dataUrl: a.dataUrl })),
    };
    const next = { ...target, messages: [...target.messages, optimistic] };
    chatRef.current = next;
    setChat(next);
    setText("");
    setAttachments([]);
    await stream(target.id, { action: "send", ...body }, optimistic.id);
  };

  const stop = () => abortRef.current?.abort();

  // Undo a reply's file changes. Returns false if the person backed out.
  const undoReply = async (chatId: string, messageId: string, ask = true): Promise<boolean> => {
    type UndoResult = { ok?: boolean; conflicts?: string[] };
    try {
      let res = await api<UndoResult>(`/api/chats/${chatId}/undo`, { method: "POST", json: { messageId } });
      if (res.conflicts?.length) {
        const go =
          !ask ||
          window.confirm(
            `These files were changed again after DeepSeek edited them:\n\n${res.conflicts.join("\n")}\n\nUndo anyway? Those later edits will be lost.`,
          );
        if (!go) return false;
        res = await api<UndoResult>(`/api/chats/${chatId}/undo`, { method: "POST", json: { messageId, force: true } });
      }
      setChat((c) =>
        c && c.id === chatId ? { ...c, messages: c.messages.map((m) => (m.id === messageId && m.role === "assistant" ? { ...m, undone: true } : m)) } : c,
      );
      showToast("Changes undone.");
      setGitCheck((n) => n + 1);
      return true;
    } catch (e) {
      showToast((e as Error).message);
      return false;
    }
  };

  // Before replacing replies that changed files, offer to undo those changes.
  const settleChanges = async (removed: ChatMessage[]): Promise<boolean> => {
    if (!chat) return true;
    const withChanges = removed.filter((m): m is AssistantMessage => m.role === "assistant" && !!m.changes?.length && !m.undone);
    if (!withChanges.length) return true;
    const files = new Set(withChanges.flatMap((m) => m.changes!.map((c) => c.path))).size;
    if (window.confirm(`The reply you're replacing changed ${files} file${files === 1 ? "" : "s"}. Undo those changes first?`)) {
      for (const m of [...withChanges].reverse()) if (!(await undoReply(chat.id, m.id))) return false;
      return true;
    }
    return window.confirm("Keep DeepSeek's changes and continue?");
  };

  const regenerate = async () => {
    if (!chat || live) return;
    const msgs = [...chat.messages];
    const removed: ChatMessage[] = [];
    while (msgs.length && msgs[msgs.length - 1].role === "assistant") removed.push(msgs.pop()!);
    if (!(await settleChanges(removed))) return;
    setChat((c) => (c ? { ...c, messages: msgs } : c));
    stream(chat.id, { action: "regenerate" });
  };

  const editMessage = async (messageId: string, newText: string) => {
    if (!chat || live) return;
    const i = chat.messages.findIndex((m) => m.id === messageId);
    if (i === -1) return;
    if (!(await settleChanges(chat.messages.slice(i + 1)))) return;
    const m = chat.messages[i] as UserMessage;
    setChat((c) => (c ? { ...c, messages: [...c.messages.slice(0, i), { ...m, text: newText.trim() }] } : c));
    stream(chat.id, { action: "edit", messageId, text: newText });
  };

  // ---------- Saving a reply to a file (you choose where) ----------

  const saveReply = async (m: AssistantMessage, mode: "new" | "append") => {
    const content = m.steps.map((s) => s.content).filter(Boolean).join("\n\n");
    const name = `${(chat?.title ?? "").replace(/[^\w\- ]+/g, "").trim() || "DeepSeek reply"}.md`;
    try {
      const r = await api<{ display?: string; cancelled?: boolean }>("/api/save-file", { method: "POST", json: { content, name, mode } });
      if (r.display) showToast(`Saved to ${r.display}`);
    } catch (e) {
      const msg = (e as Error).message;
      if (mode === "new" && /only available on macOS/.test(msg)) {
        // Not a Mac: download the file through the browser instead.
        const link = document.createElement("a");
        link.href = URL.createObjectURL(new Blob([content], { type: "text/markdown" }));
        link.download = name;
        link.click();
        URL.revokeObjectURL(link.href);
      } else showToast(msg);
    }
  };

  // ---------- Edit mode approvals ----------

  const decide = async (callId: string, decision: "approve" | "reject" | "approve_remember") => {
    const chatId = live?.chatId;
    if (!chatId) return;
    await api("/api/chat/approve", { method: "POST", json: { chatId, callId, decision } }).catch((e) => showToast(e.message));
  };

  const approveAll = async () => {
    const chatId = live?.chatId;
    if (!chatId) return;
    setChat((c) => (c && c.id === chatId ? { ...c, mode: "auto" } : c));
    await api("/api/chat/approve", { method: "POST", json: { chatId, decision: "approve_all" } }).catch((e) => showToast(e.message));
  };


  // Uncommitted-changes warning for Edit mode.
  useEffect(() => {
    if (!activeKey || !isEditingMode(prefs.mode) || live) return;
    let cancelled = false;
    Promise.all(
      activeKey.split("|").map((root) =>
        api<{ repo: boolean; changed?: number }>(`/api/folder/git?root=${encodeURIComponent(root)}`)
          .then((r) => (r.repo ? r.changed ?? 0 : 0))
          .catch(() => 0),
      ),
    ).then((counts) => !cancelled && setGitChanged(counts.reduce((a, b) => a + b, 0)));
    return () => {
      cancelled = true;
    };
  }, [activeKey, prefs.mode, live, gitCheck]);

  // ---------- Folders ----------

  const addFolder = (path: string) => {
    if (prefs.hiddenProjectFolders.includes(path)) {
      updatePrefs({ hiddenProjectFolders: prefs.hiddenProjectFolders.filter((x) => x !== path) });
      return;
    }
    if (linked.some((f) => f.path === path)) return showToast("That folder is already linked to this chat.");
    // Older chats also stored their project's folder as their own; drop those copies.
    const fromProject = projectFolders(project);
    updatePrefs({ folders: [...prefs.folders.filter((x) => !fromProject.includes(x)), path] });
  };
  const removeFolder = (path: string) => updatePrefs({ folders: prefs.folders.filter((x) => x !== path) });
  const toggleProjectFolder = (path: string) =>
    updatePrefs({
      hiddenProjectFolders: prefs.hiddenProjectFolders.includes(path)
        ? prefs.hiddenProjectFolders.filter((x) => x !== path)
        : [...prefs.hiddenProjectFolders, path],
    });

  // ---------- Projects ----------

  useEffect(() => {
    if (!currentProjectId) return;
    let cancelled = false;
    api<Project>(`/api/projects/${currentProjectId}`)
      .then((p) => !cancelled && setActiveProject(p))
      .catch(() => !cancelled && setActiveProject(null));
    return () => {
      cancelled = true;
    };
  }, [currentProjectId, projects]);

  const toggleProject = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]));
      return next;
    });
  };

  const openProjectSettings = async (id: string | null) => {
    if (!id) return setProjectDialog({ open: true, project: null });
    try {
      setProjectDialog({ open: true, project: await api<Project>(`/api/projects/${id}`) });
    } catch (e) {
      showToast((e as Error).message);
    }
  };

  const moveChat = async (chatId: string, projectId: string | null) => {
    setChats((list) => list.map((c) => (c.id === chatId ? { ...c, projectId } : c)));
    if (chat?.id === chatId) setChat({ ...chat, projectId });
    if (projectId) {
      setExpanded((prev) => {
        const next = new Set(prev).add(projectId);
        localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]));
        return next;
      });
    }
    await api(`/api/chats/${chatId}`, { method: "PATCH", json: { projectId } }).catch((e) => showToast(e.message));
  };

  const deleteProject = async (id: string) => {
    setProjects((list) => list.filter((x) => x.id !== id));
    setChats((list) => list.map((c) => (c.projectId === id ? { ...c, projectId: null } : c)));
    if (chat?.projectId === id) setChat({ ...chat, projectId: null });
    if (!chat && draftPrefs.projectId === id) setDraftPrefs((p) => ({ ...p, projectId: null }));
    await api(`/api/projects/${id}`, { method: "DELETE" }).catch((e) => showToast(e.message));
    showToast("Project deleted. Its chats are still in your chat list.");
  };

  // ---------- Scrolling ----------

  const liveHere = live && chat && live.chatId === chat.id ? live.assistant : null;

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [chat?.messages.length, chat?.id, liveHere]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stickRef.current = near;
    setAtBottom(near);
  };

  // ---------- Keyboard shortcuts ----------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        newChat();
      } else if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSidebarOpen(true);
        setTimeout(() => searchRef.current?.focus());
      } else if (mod && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setSidebarOpen((o) => !o);
      } else if (mod && e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      } else if (e.key === "Escape" && abortRef.current && !settingsOpen && !folderOpen) {
        abortRef.current.abort();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newChat, settingsOpen, folderOpen]);

  // ---------- Derived values ----------

  const messages = useMemo(() => chat?.messages ?? [], [chat]);
  const contextTokens = useMemo(() => {
    const all = liveHere ? [...messages, liveHere] : messages;
    for (let i = all.length - 1; i >= 0; i--) {
      const m = all[i];
      if (m.role === "assistant" && m.contextTokens) {
        // Add anything sent after that reply (e.g. a message still waiting for its answer).
        const after = all.slice(i + 1).reduce((n, x) => n + (x.role === "user" ? estimateTokens(x.text + (x.files ?? "")) : 0), 0);
        return m.contextTokens + after;
      }
    }
    return all.reduce((n, m) => n + (m.role === "user" ? estimateTokens(m.text + (m.files ?? "")) : 0), 0);
  }, [messages, liveHere]);
  const chatCost = messages.reduce((n, m) => n + (m.role === "assistant" ? m.usage?.cost ?? 0 : 0), 0) + (liveHere?.usage?.cost ?? 0);

  const busyElsewhere = !!live && live.chatId !== chat?.id;
  const keyMissing = keyStatus !== null && !keyStatus.configured;
  const isEmpty = messages.length === 0 && !liveHere;
  const lastIndex = messages.length - 1;

  const composer = (
    <Composer
      text={text}
      setText={setText}
      attachments={attachments}
      setAttachments={setAttachments}
      onAddFiles={addFiles}
      onSend={send}
      onStop={stop}
      streaming={!!liveHere}
      model={prefs.model}
      thinking={prefs.thinking}
      effort={prefs.effort}
      onPrefs={updatePrefs}
      webSearch={prefs.webSearch && !!settings?.webSearch}
      github={prefs.github && githubState === "ready"}
      githubState={githubState}
      onGithubSetup={() => (githubState === "no-repos" && project ? openProjectSettings(project.id) : setSettingsOpen(true))}
      mode={prefs.mode}
      gitChanged={isEditingMode(prefs.mode) ? gitChanged : 0}
      searchEnabled={!!settings?.webSearch}
      folders={linked}
      onOpenFolder={() => {
        setDropped(null);
        setFolderOpen(true);
      }}
      onRemoveFolder={removeFolder}
      onToggleProjectFolder={toggleProjectFolder}
      contextTokens={contextTokens}
      chatCost={chatCost}
      focusKey={chat?.id ?? "new"}
      placeholder={
        busyElsewhere ? "Another chat is still replying…" : isEmpty && !activeFolders.length ? (project ? `Message ${project.name}…` : "How can I help you today?") : undefined
      }
    />
  );

  if (!mounted) return <div className="h-full bg-app" />;

  return (
    <div
      className="flex h-full"
      onDragEnter={(e) => {
        if (e.dataTransfer.types.includes("Files")) setDragging(true);
      }}
    >
      {sidebarOpen && narrow && <div className="fixed inset-0 z-30 bg-black/30" onClick={() => setSidebarOpen(false)} />}
      {sidebarOpen ? (
        <div className={clsx("h-full", narrow && "fixed inset-y-0 left-0 z-40 shadow-2xl")}>
        <Sidebar
          ref={searchRef}
          chats={chats}
          activeId={chat?.id ?? null}
          streamingId={live?.chatId ?? null}
          search={search}
          onSearch={setSearch}
          onSelect={selectChat}
          onNew={() => newChat()}
          onRename={renameChat}
          onDelete={deleteChat}
          onCollapse={() => setSidebarOpen(false)}
          onSettings={() => setSettingsOpen(true)}
          keyMissing={keyMissing}
          projects={projects}
          activeProjectId={currentProjectId}
          expanded={expanded}
          onToggleProject={toggleProject}
          onNewProject={() => openProjectSettings(null)}
          onEditProject={(id) => openProjectSettings(id)}
          onNewChatInProject={(id) => newChat(id)}
          onMoveChat={moveChat}
        />
        </div>
      ) : (
        <div className="flex w-13 shrink-0 flex-col items-center gap-1 border-r border-line bg-sidebar py-2.5 max-md:w-11">
          <IconButton label="Show sidebar (⌘B)" onClick={() => setSidebarOpen(true)}>
            <PanelLeftOpen size={17} />
          </IconButton>
          <IconButton label="New chat (⌘⇧O)" onClick={() => newChat()}>
            <SquarePen size={17} />
          </IconButton>
          <div className="flex-1" />
          <IconButton label="Settings" onClick={() => setSettingsOpen(true)}>
            <SettingsIcon size={17} />
          </IconButton>
        </div>
      )}

      <main className="relative flex min-w-0 flex-1 flex-col">
        <header className="flex h-13 shrink-0 items-center gap-2 px-4">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 text-[14px]">
            {project && (
              <>
                <button
                  type="button"
                  onClick={() => openProjectSettings(project.id)}
                  className="flex min-w-0 shrink items-center gap-1.5 rounded-md px-1.5 py-0.5 text-muted hover:bg-hover hover:text-fg"
                  title="Project settings"
                >
                  <Layers size={14} className="shrink-0 text-accent" />
                  <span className="truncate">{project.name}</span>
                </button>
                {chat && !isEmpty && <span className="text-faint">/</span>}
              </>
            )}
            <span className="truncate font-medium text-fg/90">{chat && !isEmpty ? chat.title : ""}</span>
          </div>
          {activeFolders.length > 0 && !isEmpty && (
            <div className="flex items-center gap-1.5 text-[12.5px] text-muted" title={activeFolders.map((f) => f.path).join("\n")}>
              <FolderOpen size={13} /> {activeFolders[0].name}
              {activeFolders.length > 1 && ` +${activeFolders.length - 1}`}
            </div>
          )}
        </header>

        {isEmpty ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-4 pb-[10vh]">
            {project ? (
              <div className="mb-6 flex max-w-2xl flex-col items-center text-center">
                <div className="mb-2 flex items-center gap-2.5">
                  <Layers size={26} className="text-accent" />
                  <h1 className="text-[28px] font-medium tracking-tight">{project.name}</h1>
                </div>
                {project.context.trim() ? (
                  <p className="line-clamp-2 max-w-xl text-[13.5px] text-muted">{project.context.trim()}</p>
                ) : (
                  <p className="text-[13.5px] text-muted">Add context so every chat in this project knows what it&apos;s about.</p>
                )}
                <button
                  type="button"
                  onClick={() => openProjectSettings(project.id)}
                  className="mt-2 inline-flex items-center gap-1.5 text-[12.5px] text-accent hover:underline"
                >
                  <SlidersHorizontal size={12} />
                  {project.context.trim() ? "Edit context" : "Add context"}
                  {project.files.length > 0 && ` · ${project.files.length} file${project.files.length === 1 ? "" : "s"}`}
                  {projectFolders(project).length > 0 &&
                    ` · ${projectFolders(project)
                      .map((f) => f.split("/").pop())
                      .join(", ")}`}
                </button>
              </div>
            ) : (
              <div className="mb-7 flex items-center gap-3">
                <Logo size={34} />
                <h1 className="text-[30px] font-medium tracking-tight">{greeting()}</h1>
              </div>
            )}
            <div className="w-full max-w-2xl">{composer}</div>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <QuickAction
                icon={<FolderOpen size={14} />}
                label="Open a project folder"
                onClick={() => {
                  setDropped(null);
                  setFolderOpen(true);
                }}
              />
              <QuickAction
                icon={<Paperclip size={14} />}
                label="Upload files"
                onClick={() => {
                  const input = document.createElement("input");
                  input.type = "file";
                  input.multiple = true;
                  input.onchange = () => addFiles(Array.from(input.files ?? []));
                  input.click();
                }}
              />
            </div>
            {keyMissing && (
              <div className="mt-8 flex max-w-lg items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-3 text-[13.5px]">
                <KeyRound size={18} className="shrink-0 text-accent" />
                <span className="flex-1 text-muted">Add your DeepSeek API key to start chatting. It&apos;s stored in your Mac&apos;s Keychain.</span>
                <Button variant="primary" onClick={() => setSettingsOpen(true)}>
                  Add key
                </Button>
              </div>
            )}
          </div>
        ) : (
          <>
            <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
              <div className="mx-auto max-w-3xl space-y-7 px-4 pb-10 pt-4 md:px-6">
                {messages.map((m, i) =>
                  m.role === "user" ? (
                    <UserBubble key={m.id} message={m} canEdit={!live && !m.id.startsWith("tmp-")} onEdit={(t) => editMessage(m.id, t)} />
                  ) : (
                    <AssistantBlock
                      key={m.id}
                      message={m}
                      streaming={false}
                      isLast={i === lastIndex && !liveHere}
                      onRegenerate={regenerate}
                      onOpenSettings={() => setSettingsOpen(true)}
                      onUndo={m.changes?.length && !m.undone && chat ? () => undoReply(chat.id, m.id) : undefined}
                      onSave={(mode) => saveReply(m, mode)}
                    />
                  ),
                )}
                {liveHere && (
                  <AssistantBlock
                    message={liveHere}
                    streaming
                    isLast
                    onRegenerate={regenerate}
                    onOpenSettings={() => setSettingsOpen(true)}
                    onDecide={decide}
                    onApproveAll={approveAll}
                  />
                )}
              </div>
            </div>
            <div className="relative mx-auto w-full max-w-3xl px-2 pb-3 md:px-4">
              {!atBottom && (
                <button
                  type="button"
                  aria-label="Scroll to bottom"
                  onClick={() => {
                    stickRef.current = true;
                    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
                  }}
                  className="absolute -top-11 left-1/2 flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-full border border-line bg-surface text-muted shadow-md hover:text-fg"
                >
                  <ArrowDown size={16} />
                </button>
              )}
              {composer}
              <p className="mt-2 text-center text-[11px] text-faint">DeepSeek can make mistakes. Check important info.</p>
            </div>
          </>
        )}
      </main>

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        keyStatus={keyStatus}
        searchKey={searchKey}
        githubKey={githubKey}
        defaultSystemPrompt={defaultSystemPrompt}
        onSaved={(s, k, sk, gk) => {
          setSettings(s);
          setKeyStatus(k);
          setSearchKey(sk);
          setGithubKey(gk);
          if (!chatRef.current) setDraftPrefs((p) => ({ ...p, model: s.defaultModel, thinking: s.thinking, effort: s.effort }));
        }}
      />
      <ProjectDialog
        open={projectDialog.open}
        project={projectDialog.project}
        allowedRepos={settings?.githubRepos ?? []}
        defaultDocsFolder={settings?.docsFolder ?? ""}
        onClose={() => setProjectDialog({ open: false, project: null })}
        onSaved={(saved) => {
          refreshProjects();
          setActiveProject((cur) => (cur?.id === saved.id ? saved : cur));
          if (!projectDialog.project) newChat(saved.id);
        }}
        onDelete={deleteProject}
      />
      <FolderDialog
        open={folderOpen}
        onClose={() => {
          setFolderOpen(false);
          setDropped(null);
        }}
        dropped={dropped}
        onAttach={addReadyAttachments}
        onSetWorkspace={(p) => {
          rememberFolder(p);
          addFolder(p);
        }}
      />

      {dragging && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-app/80 backdrop-blur-sm"
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={(e) => {
            if (e.currentTarget === e.target) setDragging(false);
          }}
          onDrop={onDrop}
        >
          <div className="pointer-events-none flex flex-col items-center gap-3 rounded-3xl border-2 border-dashed border-accent/50 bg-surface px-16 py-12 text-center">
            <Upload size={30} className="text-accent" />
            <div className="text-[17px] font-semibold">Drop to attach</div>
            <div className="text-[13px] text-muted">Files, images, PDFs, Word docs — or a whole folder</div>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-xl bg-fg px-4 py-2.5 text-[13.5px] text-app shadow-xl">{toast}</div>
      )}
    </div>
  );
}

function QuickAction({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx("flex h-8 items-center gap-2 rounded-full border border-line bg-surface px-3.5 text-[13px] text-muted hover:bg-hover hover:text-fg")}
    >
      {icon}
      {label}
    </button>
  );
}
