"use client";
// The whole app: sidebar, conversation, composer, dialogs, drag-and-drop.
import clsx from "clsx";
import { ArrowDown, FolderOpen, KeyRound, Layers, PanelLeftOpen, Paperclip, Settings as SettingsIcon, SlidersHorizontal, SquarePen, Upload } from "lucide-react";
import { nanoid } from "nanoid";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api, fileToAttachment, readEvents, walkDroppedFolder, type DraftAttachment, type LocalFile } from "@/lib/client";
import { estimateTokens } from "@/lib/tokens";
import {
  aiName,
  DEEPSEEK_MODELS,
  isEffort,
  modelInfoFor,
  nearestEffort,
  providerOf,
  type ModelInfo,
  type ProviderLimits,
} from "@/lib/models";
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
  ProcessInfo,
  ProjectSummary,
  Settings,
  ToolCall,
  UserMessage,
} from "@/lib/types";
import { isEditingMode } from "@/lib/types";
import { baseName, folderKey, linkedFolders, ownFolders, projectFolders } from "@/lib/folders";
import { platformOf, type Platform } from "@/lib/commands";
import { Composer } from "./Composer";
import { FolderDialog, rememberFolder, type DroppedFolder } from "./FolderDialog";
import { RunContext, type RunTarget } from "./Markdown";
import { AssistantBlock, QueuedBubble, SummaryDivider, UserBubble } from "./Message";
import { ProjectDialog } from "./ProjectDialog";
import { ProcsContext, RunningButton } from "./RunningList";
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
  code: boolean;
  mode: Mode;
  autoApprove: boolean;
  runWithoutAsking: boolean; // "Run commands without asking" (Edit and Auto mode)
  projectId: string | null;
};
type SettingsData = {
  settings: Settings;
  key: KeyStatus;
  claudeKey: KeyStatus;
  searchKey: KeyStatus;
  githubKey: KeyStatus;
  models: { deepseek: ModelInfo[]; claude: ModelInfo[] };
  defaultSystemPrompt: string;
  platform: string;
};
const EXPANDED_KEY = "expandedProjects";
// Chats that can reply at the same time. Each reply keeps a connection open, and browsers allow
// about 6 per app, so this leaves room for everything else (loading chats, the Running list…).
const MAX_REPLIES = 4;
// A reply in progress, plus what it may change (for the "another chat is editing this folder" warning).
type LiveReply = { assistant: AssistantMessage; editing: boolean; folders: string[]; status?: string | null };
// A message you sent while that chat was still replying. It waits for the reply's next step.
// text/attachments are kept so it can go back into the message box if it isn't delivered.
type Queued = { message: UserMessage; text: string; attachments: DraftAttachment[]; now?: boolean };
type Draft = { text: string; attachments: DraftAttachment[] };

const cloneAssistant = (a: AssistantMessage): AssistantMessage => ({
  ...a,
  usage: a.usage ? { ...a.usage } : undefined,
  steps: a.steps.map((s) => ({ ...s, toolCalls: s.toolCalls?.map((c) => ({ ...c, ...(c.command ? { command: { ...c.command } } : {}) })) })),
});

// A new chat's model: the default from Settings, if its provider has a key; otherwise the other
// provider's first model. Thinking and effort come from that provider's defaults.
function newChatModel(d: { settings: Settings; key: KeyStatus | null; claudeKey: KeyStatus | null; models: { deepseek: ModelInfo[]; claude: ModelInfo[] } }) {
  const s = d.settings;
  const usable = [...(d.key?.configured ? d.models.deepseek : []), ...(d.claudeKey?.configured ? d.models.claude : [])];
  const model = !usable.length || usable.some((m) => m.id === s.defaultModel) ? s.defaultModel : usable[0].id;
  const claude = providerOf(model) === "claude";
  const effort = claude ? s.claudeEffort : s.effort;
  return { model, thinking: claude ? s.claudeThinking : s.thinking, effort: isEffort(effort) ? effort : ("high" as const) };
}

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
  const [claudeKey, setClaudeKey] = useState<KeyStatus | null>(null);
  const [models, setModels] = useState<{ deepseek: ModelInfo[]; claude: ModelInfo[] }>({ deepseek: DEEPSEEK_MODELS, claude: [] });
  const [summarizing, setSummarizing] = useState(false);
  const [searchKey, setSearchKey] = useState<KeyStatus | null>(null);
  const [githubKey, setGithubKey] = useState<KeyStatus | null>(null);
  const [defaultSystemPrompt, setDefaultSystemPrompt] = useState("");
  const [platform, setPlatform] = useState<Platform>("mac");
  const [procs, setProcs] = useState<ProcessInfo[] | null>(null); // the Running list (null until first fetched)
  const [draftPrefs, setDraftPrefs] = useState<Prefs>({
    model: "deepseek-flash",
    thinking: true,
    effort: "high",
    folders: [],
    hiddenProjectFolders: [],
    webSearch: false,
    github: false,
    code: false,
    mode: "ask",
    autoApprove: false,
    runWithoutAsking: false,
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
  const [lives, setLives] = useState<Record<string, LiveReply>>({}); // replies in progress, by chat
  const [queued, setQueued] = useState<Record<string, Queued[]>>({}); // messages waiting for a reply's next step, by chat
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

  const abortRefs = useRef(new Map<string, AbortController>()); // one per chat that's replying
  const doneAway = useRef(new Map<string, AssistantMessage>()); // replies that finished while you were in another chat
  const queuedRef = useRef<Record<string, Queued[]>>({}); // same as `queued`, always current
  const delivered = useRef(new Set<string>()); // waiting messages the AI has already been given
  const chatsRef = useRef<ChatSummary[]>([]);
  const chatRef = useRef<Chat | null>(null);
  const draftPrefsRef = useRef(draftPrefs);
  const drafts = useRef(new Map<string, Draft>());
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  // Where you'd scrolled to in each chat (only kept when you weren't at the bottom), so going
  // back to a chat puts you where you left off.
  const scrollPositions = useRef(new Map<string, number>());
  const restoreScroll = useRef<number | null>(null);

  useEffect(() => {
    chatRef.current = chat;
  }, [chat]);
  useEffect(() => {
    chatsRef.current = chats;
  }, [chats]);
  useEffect(() => {
    draftPrefsRef.current = draftPrefs;
  }, [draftPrefs]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 4500);
  }, []);

  // Waiting messages: kept in a ref too, so the stream handler always sees the latest list.
  const updateQueued = useCallback((chatId: string, fn: (list: Queued[]) => Queued[]) => {
    const next = { ...queuedRef.current, [chatId]: fn(queuedRef.current[chatId] ?? []) };
    if (!next[chatId].length) delete next[chatId];
    queuedRef.current = next;
    setQueued(next);
  }, []);

  // Put text and attachments back into a chat's message box (or its saved draft, if you're elsewhere).
  const returnToBox = useCallback((chatId: string, back: string, atts: DraftAttachment[]) => {
    if (!back && !atts.length) return;
    if (chatRef.current?.id === chatId) {
      setText((t) => [back, t.trim()].filter(Boolean).join("\n\n"));
      setAttachments((prev) => [...atts, ...prev]);
    } else {
      const d = drafts.current.get(chatId) ?? { text: "", attachments: [] };
      drafts.current.set(chatId, { text: [back, d.text.trim()].filter(Boolean).join("\n\n"), attachments: [...atts, ...d.attachments] });
    }
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

  const applySettingsData = useCallback((data: SettingsData) => {
    setSettings(data.settings);
    setKeyStatus(data.key);
    setClaudeKey(data.claudeKey);
    setSearchKey(data.searchKey);
    setGithubKey(data.githubKey);
    setModels(data.models);
    setDefaultSystemPrompt(data.defaultSystemPrompt);
    setPlatform(platformOf(data.platform));
  }, []);

  const loadSettings = useCallback(async () => {
    const data = await api<SettingsData>("/api/settings");
    applySettingsData(data);
    return data;
  }, [applySettingsData]);

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
        let c = await api<Chat>(`/api/chats/${id}`);
        // A reply that finished while you were elsewhere is saved, but this copy may have been
        // fetched a moment before it was: add it if it's missing.
        const done = doneAway.current.get(id);
        if (done && !abortRefs.current.has(id)) {
          doneAway.current.delete(id);
          if (!c.messages.some((m) => m.id === done.id)) c = { ...c, messages: [...c.messages, done] };
        }
        // Back where you left off in this chat, or at the bottom if you hadn't scrolled up.
        const saved = scrollPositions.current.get(c.id);
        restoreScroll.current = saved ?? null;
        stickRef.current = saved === undefined;
        setChat(c);
        restoreDraft(c.id);
      } catch {
        setChat(null);
        window.history.replaceState(null, "", "/");
        showToast("That chat couldn't be found.");
      }
    },
    [restoreDraft, showToast],
  );

  useEffect(() => {
    api<SettingsData>("/api/settings")
      .then((data) => {
        applySettingsData(data);
        setDraftPrefs((p) => ({ ...p, ...newChatModel(data) }));
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
  }, [loadChat, showToast, applySettingsData]);

  // Search as you type.
  useEffect(() => {
    const t = setTimeout(() => refreshChats(search), 150);
    return () => clearTimeout(t);
  }, [search, refreshChats]);

  // The Running list: checked every few seconds while the window is visible, and right away
  // when you come back to it (commands keep running while the window is closed).
  const refreshProcs = useCallback(async () => {
    try {
      setProcs(await api<ProcessInfo[]>("/api/processes"));
    } catch {}
  }, []);
  useEffect(() => {
    const poll = () => !document.hidden && api<ProcessInfo[]>("/api/processes").then(setProcs).catch(() => {});
    api<ProcessInfo[]>("/api/processes")
      .then(setProcs)
      .catch(() => {});
    const t = setInterval(poll, 3000);
    const onVisible = () => poll();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

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
        ...(settings ? newChatModel({ settings, key: keyStatus, claudeKey, models }) : { model: p.model, thinking: p.thinking, effort: p.effort }),
        folders: [], // project folders are linked automatically
        hiddenProjectFolders: [],
        webSearch: false,
        github: false,
        code: false,
        mode: "ask",
        autoApprove: false,
        runWithoutAsking: false, // off in every new chat
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
    [saveDraft, restoreDraft, settings, keyStatus, claudeKey, models],
  );

  const renameChat = async (id: string, title: string) => {
    setChats((list) => list.map((c) => (c.id === id ? { ...c, title } : c)));
    if (chat?.id === id) setChat({ ...chat, title });
    await api(`/api/chats/${id}`, { method: "PATCH", json: { title } }).catch((e) => showToast(e.message));
  };

  const deleteChat = async (id: string) => {
    abortRefs.current.get(id)?.abort();
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
        code: !!chat.code,
        mode: chat.mode === "edit" && chat.autoApprove ? "auto" : (chat.mode ?? "ask"),
        autoApprove: !!chat.autoApprove,
        runWithoutAsking: !!chat.runWithoutAsking,
        projectId: chat.projectId ?? null,
      }
    : draftPrefs;

  // The chat's model, what it can do, and what its provider may do (Settings → limits).
  const available = useMemo(() => {
    const list = [...(keyStatus?.configured ? models.deepseek : []), ...(claudeKey?.configured ? models.claude : [])];
    return list.length ? list : models.deepseek; // no key yet: show DeepSeek's models
  }, [keyStatus, claudeKey, models]);
  const info = modelInfoFor(prefs.model, models.claude);
  const ai = aiName(prefs.model);
  const limits: ProviderLimits = settings?.limits[info.provider] ?? { folders: true, edit: true, auto: true, commands: true, github: true, docs: true, search: true, code: false };
  // The mode that applies: Edit and Auto only where this provider may change files.
  const mode: Mode = isEditingMode(prefs.mode) && !limits.edit ? "ask" : prefs.mode === "auto" && !limits.auto ? "edit" : prefs.mode;

  // The current chat's project, and every folder the AI can use here.
  const currentProjectId = chat ? chat.projectId ?? null : draftPrefs.projectId;
  const project = currentProjectId && activeProject?.id === currentProjectId ? activeProject : null;
  const linked = useMemo(
    () => linkedFolders(prefs.folders, prefs.projectId ? projectFolders(project) : [], prefs.hiddenProjectFolders),
    [prefs.folders, prefs.projectId, prefs.hiddenProjectFolders, project],
  );
  const activeFolders = linked.filter((f) => !f.hidden);
  const activeKey = activeFolders.map((f) => f.path).join("|");

  // This chat's reply in progress, if it's replying.
  const liveHere = chat ? (lives[chat.id]?.assistant ?? null) : null;
  const replyingHere = !!liveHere;

  // ▶ Run on code blocks: only in a project with Terminal on, in the project's own folders.
  const runChatId = chat?.id ?? null;
  const terminalOn = !!project?.terminal;
  const runTarget = useMemo<RunTarget | null>(() => {
    const folders = terminalOn ? linked.filter((f) => !f.hidden && f.source === "project").map((f) => f.name) : [];
    if (!runChatId || !folders.length) return null;
    return {
      chatId: runChatId,
      folders,
      platform,
      ai,
      onStarted: refreshProcs,
      sendOutput: (command, output) => {
        const body = `$ ${command}\n\n${output.length > 100_000 ? "…" + output.slice(-100_000) : output}`;
        setAttachments((prev) => [
          ...prev,
          { id: nanoid(10), name: `Terminal output (${command.split("\n")[0].slice(0, 40)})`, kind: "file", size: body.length, content: body, status: "ready" },
        ]);
        showToast("Output added to your message.");
      },
    };
  }, [runChatId, terminalOn, linked, platform, ai, refreshProcs, showToast]);

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
    if (patch.webSearch && providerOf(prefs.model) === "deepseek" && !searchKey?.configured) {
      showToast("Add your free Tavily key to use web search with DeepSeek.");
      setSettingsOpen(true);
      return;
    }
    if (patch.model && settings) {
      // Another provider: start from that provider's defaults. Same provider: keep the effort if
      // the new model takes it.
      const next = modelInfoFor(patch.model, models.claude);
      if (next.provider !== providerOf(prefs.model)) {
        const d = next.provider === "claude" ? { thinking: settings.claudeThinking, effort: settings.claudeEffort } : { thinking: settings.thinking, effort: settings.effort };
        patch = { ...d, ...patch };
      }
      const effort = nearestEffort(patch.effort ?? prefs.effort, next.efforts);
      if (effort) patch = { ...patch, effort };
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
              code: saved.code,
              mode: saved.mode,
              autoApprove: saved.autoApprove,
              runWithoutAsking: saved.runWithoutAsking,
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

  // Claude with Code on: data files (and spreadsheets) also go into its code sandbox.
  const sandbox = info.provider === "claude" && limits.code && prefs.code;
  const addFiles = useCallback(
    (files: File[]) => {
      for (const file of files) {
        const id = nanoid(10);
        setAttachments((prev) => [...prev, { id, name: file.name, kind: "file", size: file.size, status: "loading" }]);
        fileToAttachment(file, file.name, { sandbox })
          .then((a) => setAttachments((prev) => prev.map((x) => (x.id === id ? { ...a, id, status: "ready" } : x))))
          .catch((e: Error) => {
            setAttachments((prev) => prev.map((x) => (x.id === id ? { ...x, status: "error", error: e.message } : x)));
            setTimeout(() => setAttachments((prev) => prev.filter((x) => x.id !== id)), 6000);
          });
      }
    },
    [sandbox],
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

  // Is there room for another reply? (Up to MAX_REPLIES chats can reply at once.)
  const roomForReply = () => {
    if (abortRefs.current.size < MAX_REPLIES) return true;
    showToast(`${MAX_REPLIES} chats are already replying. Wait for one to finish, or stop one, before starting another.`);
    return false;
  };

  const stream = async (chatId: string, body: Record<string, unknown>, optimisticId?: string) => {
    const ac = new AbortController();
    abortRefs.current.set(chatId, ac);
    doneAway.current.delete(chatId);
    if (chatRef.current?.id === chatId || !chatRef.current) stickRef.current = true;
    // What this reply may change, for the warning when two chats edit the same folder.
    const editing = isEditingMode(mode);
    const folders = activeFolders.map((f) => f.path);
    const model = chatRef.current?.id === chatId ? chatRef.current.model : draftPrefsRef.current.model;
    const a: AssistantMessage = { id: `live-${nanoid(8)}`, role: "assistant", createdAt: new Date().toISOString(), model, steps: [] };
    const cur = () => {
      if (!a.steps.length) a.steps.push({ content: "" });
      return a.steps[a.steps.length - 1];
    };
    let frame = 0;
    let status: string | null = null;
    const show = () => setLives((m) => ({ ...m, [chatId]: { assistant: cloneAssistant(a), editing, folders, status } }));
    const flush = () => {
      frame = 0;
      show();
    };
    show();

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
              if (call) Object.assign(call, { diff: ev.diff, status: "pending", ...(ev.command ? { command: ev.command } : {}) });
            }
            if (chatRef.current?.id !== chatId) {
              const title = chatsRef.current.find((c) => c.id === chatId)?.title;
              showToast(`${title ? `“${title}”` : "Another chat"} is waiting for you to approve something.`);
            }
            break;
          case "command":
            for (const s of a.steps) {
              const call = s.toolCalls?.find((c) => c.id === ev.id);
              if (!call) continue;
              // The final update carries the output; until then, keep what streamed in.
              call.command = ev.command.output !== undefined ? ev.command : { ...ev.command, output: call.command?.output };
              if (call.status === "pending" && ev.command.status !== "pending") call.status = undefined;
              if (ev.command.status === "running" && ev.command.background) refreshProcs();
            }
            break;
          case "split": {
            // Your waiting messages went in. The reply so far (if anything was written) and your
            // messages are now part of the chat, and the reply carries on (or starts over).
            for (const u of ev.users) delivered.current.add(u.id);
            const add: ChatMessage[] = [...(ev.done ? [ev.done] : []), ...ev.users];
            setChat((c) => (c && c.id === chatId ? { ...c, messages: [...c.messages, ...add] } : c));
            const ids = new Set(ev.users.map((u) => u.id));
            updateQueued(chatId, (list) => list.filter((q) => !ids.has(q.message.id)));
            if (ev.next) {
              a.id = ev.next.id;
              a.model = ev.next.model;
            }
            a.steps = [];
            a.usage = undefined;
            a.contextTokens = undefined;
            a.cutOff = undefined;
            break;
          }
          case "step_cut": {
            // "Answer together now" cut off what it was writing.
            if (ev.drop) a.steps.splice(Math.max(0, a.steps.length - (ev.count ?? 1)));
            else {
              const s = cur();
              s.toolCalls = s.toolCalls?.filter((c) => c.server && c.summary !== undefined);
              if (s.content) {
                s.content = `${s.content.trimEnd()} …`;
                a.cutOff = true;
              } else s.reasoning = undefined;
            }
            break;
          }
          case "command_output":
            for (const s of a.steps) {
              const call = s.toolCalls?.find((c) => c.id === ev.id);
              if (call?.command) call.command = { ...call.command, output: ((call.command.output ?? "") + ev.chunk).slice(-200_000) };
            }
            break;
          case "tool_result":
            for (const s of a.steps) {
              const call = s.toolCalls?.find((c) => c.id === ev.id);
              if (call)
                Object.assign(call, {
                  summary: ev.summary,
                  ok: ev.ok,
                  sources: ev.sources ?? call.sources,
                  diff: ev.diff ?? call.diff,
                  status: ev.status,
                  ...(ev.result !== undefined ? { result: ev.result } : {}),
                  ...(ev.files ? { files: ev.files } : {}),
                });
            }
            break;
          case "ping":
            break;
          case "status":
            status = ev.text;
            break;
          case "summary":
            setChat((c) => (c && c.id === chatId ? { ...c, summary: ev.summary, extraCost: ev.extraCost } : c));
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
    // Stopped (or cut off) before the server's final copy arrived: nothing is waiting for you any
    // more, and a command that was running was stopped along with the reply.
    const settle = (c: ToolCall): ToolCall => {
      const command =
        c.command?.status === "pending"
          ? { ...c.command, status: "denied" as const }
          : c.command?.status === "running" && !c.command.background
            ? { ...c.command, status: "stopped" as const }
            : c.command;
      return { ...c, status: c.status === "pending" ? undefined : c.status, ...(command ? { command } : {}) };
    };
    const result: AssistantMessage = final ?? {
      ...cloneAssistant(a),
      steps: a.steps.filter((s) => s.content || s.reasoning || s.toolCalls?.length).map((s) => ({ ...s, toolCalls: s.toolCalls?.map(settle) })),
    };
    setChat((c) => (c && c.id === chatId ? (c.messages.some((m) => m.id === result.id) ? c : { ...c, messages: [...c.messages, result] }) : c));
    doneAway.current.set(chatId, result); // in case you open this chat again before it's reloaded
    setLives((m) => {
      const next = { ...m };
      delete next[chatId];
      return next;
    });
    if (abortRefs.current.get(chatId) === ac) abortRefs.current.delete(chatId);
    // Messages still waiting weren't delivered (you pressed Stop, or the reply failed): back into
    // the message box, so nothing is sent without you.
    const left = (queuedRef.current[chatId] ?? []).filter((q) => !delivered.current.has(q.message.id));
    updateQueued(chatId, () => []);
    if (left.length) {
      returnToBox(
        chatId,
        left.map((q) => q.text).filter(Boolean).join("\n\n"),
        left.flatMap((q) => q.attachments),
      );
      showToast(left.length === 1 ? "Your waiting message wasn't sent, so it's back in the message box." : "Your waiting messages weren't sent, so they're back in the message box.");
    }
    refreshChats(search);
    if (result.error && /api key/i.test(result.error)) loadSettings().catch(() => {});
  };

  const send = async () => {
    if (liveHere) return queueMessage(); // still replying: the AI reads it at its next step
    if (!roomForReply()) return;
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

  // While this chat is replying: the message waits for the reply's next step.
  const queueMessage = async () => {
    const chatId = chatRef.current?.id;
    if (!chatId) return;
    const ready = attachments.filter((a) => a.status === "ready");
    const typed = text.trim();
    if (!typed && !ready.length) return;
    setText("");
    setAttachments((prev) => prev.filter((a) => a.status !== "ready"));
    stickRef.current = true;
    try {
      const res = await fetch("/api/chat/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        body: JSON.stringify({ chatId, text: typed, attachments: ready.map(({ status, error, ...a }) => a) }),
      });
      const d = (await res.json().catch(() => ({}))) as { message?: UserMessage; error?: string };
      if (!res.ok || !d.message) {
        returnToBox(chatId, typed, ready);
        showToast(res.status === 409 ? `${ai} just finished. Press Enter to send your message.` : d.error || "Couldn't send that.");
        return;
      }
      if (delivered.current.has(d.message.id)) return; // it already went in
      if (!abortRefs.current.has(chatId)) {
        // The reply ended while this was on its way.
        returnToBox(chatId, typed, ready);
        showToast(`${ai} just finished. Press Enter to send your message.`);
        return;
      }
      updateQueued(chatId, (list) => [...list, { message: d.message!, text: typed, attachments: ready }]);
    } catch {
      returnToBox(chatId, typed, ready);
      showToast("Couldn't reach the app.");
    }
  };

  // Take a waiting message back into the message box.
  const cancelQueued = async (chatId: string, q: Queued) => {
    const r = await api<{ ok: boolean }>("/api/chat/queue", { method: "POST", json: { chatId, cancel: q.message.id } }).catch(() => ({ ok: false }));
    if (!r.ok) return showToast(`Too late: ${ai} has already read it.`);
    updateQueued(chatId, (list) => list.filter((x) => x.message.id !== q.message.id));
    returnToBox(chatId, q.text, q.attachments);
  };

  // "Answer together now": cut off what the AI is writing so it starts again with your messages.
  const answerTogether = async (chatId: string) => {
    updateQueued(chatId, (list) => list.map((x) => ({ ...x, now: true })));
    const r = await api<{ cut: boolean; phase?: string }>("/api/chat/queue", { method: "POST", json: { chatId, now: true } }).catch(() => ({ cut: false, phase: undefined }));
    if (r.cut) return;
    updateQueued(chatId, (list) => list.map((x) => ({ ...x, now: false })));
    if (r.phase === "approval") showToast(`${ai} is waiting for your approval. It reads your message right after you decide.`);
    else if (r.phase === "tools") showToast(`${ai} is in the middle of a step. It reads your message as soon as that's done.`);
  };

  // Stop the reply in the chat you're looking at (other chats keep going).
  const stop = () => {
    const id = chatRef.current?.id;
    if (id) abortRefs.current.get(id)?.abort();
  };

  // Undo a reply's file changes. Returns false if the person backed out.
  const undoReply = async (chatId: string, messageId: string, ask = true): Promise<boolean> => {
    type UndoResult = { ok?: boolean; conflicts?: string[] };
    try {
      let res = await api<UndoResult>(`/api/chats/${chatId}/undo`, { method: "POST", json: { messageId } });
      if (res.conflicts?.length) {
        const go =
          !ask ||
          window.confirm(
            `These files were changed again after ${ai} edited them:\n\n${res.conflicts.join("\n")}\n\nUndo anyway? Those later edits will be lost.`,
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
    return window.confirm(`Keep ${ai}'s changes and continue?`);
  };

  const regenerate = async () => {
    if (!chat || liveHere || !roomForReply()) return;
    const msgs = [...chat.messages];
    const removed: ChatMessage[] = [];
    while (msgs.length && msgs[msgs.length - 1].role === "assistant") removed.push(msgs.pop()!);
    if (!(await settleChanges(removed))) return;
    setChat((c) => (c ? { ...c, messages: msgs } : c));
    stream(chat.id, { action: "regenerate" });
  };

  const editMessage = async (messageId: string, newText: string) => {
    if (!chat || liveHere || !roomForReply()) return;
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
    const name = `${(chat?.title ?? "").replace(/[^\w\- ]+/g, "").trim() || `${aiName(m.model)} reply`}.md`;
    try {
      const r = await api<{ display?: string; cancelled?: boolean }>("/api/save-file", { method: "POST", json: { content, name, mode } });
      if (r.display) showToast(`Saved to ${r.display}`);
    } catch (e) {
      const msg = (e as Error).message;
      if (mode === "new" && /only available on macOS/.test(msg)) {
        // No file dialog on this system: download the file through the browser instead.
        const link = document.createElement("a");
        link.href = URL.createObjectURL(new Blob([content], { type: "text/markdown" }));
        link.download = name;
        link.click();
        URL.revokeObjectURL(link.href);
      } else showToast(msg);
    }
  };

  // ---------- Edit mode approvals ----------

  // Approvals come from the reply in the chat you're looking at.
  const decide = async (callId: string, decision: "approve" | "reject" | "approve_remember", command?: string) => {
    const chatId = chatRef.current?.id;
    if (!chatId || !abortRefs.current.has(chatId)) return;
    await api("/api/chat/approve", { method: "POST", json: { chatId, callId, decision, command } }).catch((e) => showToast(e.message));
    // "Always allow" adds a rule to the project: show it in Project settings next time.
    if (decision === "approve_remember" && currentProjectId) api<Project>(`/api/projects/${currentProjectId}`).then(setActiveProject).catch(() => {});
  };

  const approveAll = async () => {
    const chatId = chatRef.current?.id;
    if (!chatId || !abortRefs.current.has(chatId)) return;
    setChat((c) => (c && c.id === chatId ? { ...c, mode: "auto" } : c));
    await api("/api/chat/approve", { method: "POST", json: { chatId, decision: "approve_all" } }).catch((e) => showToast(e.message));
  };


  // "Summarize now": the AI summarizes the chat so far and continues from the summary.
  const summarizeNow = async () => {
    const id = chatRef.current?.id;
    if (!id || summarizing) return;
    setSummarizing(true);
    try {
      const r = await api<{ summary: Chat["summary"]; extraCost: number }>(`/api/chats/${id}/summarize`, { method: "POST" });
      setChat((c) => (c && c.id === id ? { ...c, summary: r.summary, extraCost: r.extraCost } : c));
      showToast("Summarized. The earlier messages are still here; the AI continues from the summary.");
    } catch (e) {
      showToast((e as Error).message);
    } finally {
      setSummarizing(false);
    }
  };

  // Clicked something that's switched off for this provider.
  const limitOff = (what: keyof ProviderLimits) => {
    const label = { folders: "Reading folders", edit: "Changing files", auto: "Auto mode", commands: "Running commands", github: "Reading GitHub", docs: "Saving docs", search: "Web search", code: "Code execution" }[what];
    showToast(`${label} is off for ${ai}. Turn it on in Settings → ${ai}.`);
    setSettingsOpen(true);
  };

  // Uncommitted-changes warning for Edit mode.
  useEffect(() => {
    if (!activeKey || !isEditingMode(mode) || replyingHere) return;
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
  }, [activeKey, mode, replyingHere, gitCheck]);

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

  // Opening a chat: jump to where you left off (or the bottom) before it's drawn, so it never flickers.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const top = restoreScroll.current;
    restoreScroll.current = null;
    if (top !== null) el.scrollTop = top;
    else if (stickRef.current) el.scrollTop = el.scrollHeight;
  }, [chat?.id]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [chat?.messages.length, chat?.id, liveHere, queued]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stickRef.current = near;
    setAtBottom(near);
    if (chat) {
      if (near) scrollPositions.current.delete(chat.id); // at the bottom: keep following new messages
      else scrollPositions.current.set(chat.id, el.scrollTop);
    }
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
      } else if (e.key === "Escape" && !settingsOpen && !folderOpen) {
        // Esc stops the reply in the chat you're looking at.
        const id = chatRef.current?.id;
        if (id) abortRefs.current.get(id)?.abort();
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
  const chatCost =
    messages.reduce((n, m) => n + (m.role === "assistant" ? m.usage?.cost ?? 0 : 0), chat?.extraCost ?? 0) + (liveHere?.usage?.cost ?? 0);

  const procsNow = useMemo(() => ({ loaded: procs !== null, byId: new Map((procs ?? []).map((p) => [p.id, p])) }), [procs]);
  // Which chats are replying, and which are waiting for you to approve something.
  const streamingIds = useMemo(() => new Set(Object.keys(lives)), [lives]);
  const waitingIds = useMemo(
    () =>
      new Set(
        Object.entries(lives)
          .filter(([, l]) => l.assistant.steps.some((s) => s.toolCalls?.some((c) => c.status === "pending")))
          .map(([id]) => id),
      ),
    [lives],
  );
  const atCap = !liveHere && streamingIds.size >= MAX_REPLIES;
  // Another chat is changing one of this chat's folders right now (both in Edit or Auto mode).
  const clash = (() => {
    if (!isEditingMode(mode)) return null;
    const key = (p: string) => folderKey(p, platform === "windows");
    const mine = new Set(activeFolders.map((f) => key(f.path)));
    for (const [id, l] of Object.entries(lives)) {
      if (id === chat?.id || !l.editing) continue;
      const shared = l.folders.find((f) => mine.has(key(f)));
      if (shared) return { title: chats.find((c) => c.id === id)?.title ?? "Another chat", folder: baseName(shared) };
    }
    return null;
  })();
  const keyMissing = keyStatus !== null && !keyStatus.configured && !claudeKey?.configured;
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const canSummarize = !!chat && !liveHere && !!lastAssistant && chat.summary?.upto !== lastAssistant.id;
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
      info={info}
      models={available}
      ai={ai}
      limits={limits}
      onLimitOff={limitOff}
      thinking={prefs.thinking}
      effort={prefs.effort}
      code={prefs.code && limits.code}
      onPrefs={updatePrefs}
      webSearch={prefs.webSearch && limits.search && (info.provider === "claude" || !!settings?.webSearch)}
      github={prefs.github && githubState === "ready"}
      githubState={githubState}
      onGithubSetup={() => (githubState === "no-repos" && project ? openProjectSettings(project.id) : setSettingsOpen(true))}
      mode={mode}
      runFreely={
        // Where the AI can run commands, in Edit and Auto mode. (Auto on the Mac already runs them
        // without asking, inside the sandbox.)
        terminalOn && limits.commands && limits.folders && isEditingMode(mode) && !(platform === "mac" && mode === "auto") && linked.some((f) => !f.hidden && f.source === "project")
          ? { on: prefs.runWithoutAsking && limits.auto, allowed: limits.auto, sandboxed: platform === "mac" }
          : null
      }
      gitChanged={isEditingMode(mode) ? gitChanged : 0}
      clash={clash}
      searchShown={info.provider === "claude" || !!settings?.webSearch}
      folders={linked}
      onOpenFolder={() => {
        setDropped(null);
        setFolderOpen(true);
      }}
      onRemoveFolder={removeFolder}
      onToggleProjectFolder={toggleProjectFolder}
      contextTokens={contextTokens}
      chatCost={chatCost}
      summarized={!!chat?.summary}
      onSummarize={canSummarize ? summarizeNow : undefined}
      summarizing={summarizing}
      focusKey={chat?.id ?? "new"}
      placeholder={
        atCap
          ? `${MAX_REPLIES} chats are replying. Wait for one to finish…`
          : liveHere
            ? `Add something… ${ai} reads it at its next step`
            : isEmpty && !activeFolders.length ? (project ? `Message ${project.name}…` : "How can I help you today?") : undefined
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
          streamingIds={streamingIds}
          waitingIds={waitingIds}
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
          <RunningButton procs={procs ?? []} onChange={refreshProcs} />
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
                      .map((f) => baseName(f))
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
                <span className="flex-1 text-muted">Add a DeepSeek or Claude API key to start chatting. It&apos;s stored securely on this computer.</span>
                <Button variant="primary" onClick={() => setSettingsOpen(true)}>
                  Add key
                </Button>
              </div>
            )}
          </div>
        ) : (
          <>
            <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
              <RunContext.Provider value={runTarget}>
              <ProcsContext.Provider value={procsNow}>
              <div className="mx-auto max-w-3xl space-y-7 px-4 pb-10 pt-4 md:px-6">
                {messages.map((m, i) => (
                  <Fragment key={m.id}>
                    {m.role === "user" ? (
                      <UserBubble message={m} canEdit={!liveHere && !m.id.startsWith("tmp-")} onEdit={(t) => editMessage(m.id, t)} />
                    ) : (
                      <AssistantBlock
                        message={m}
                        streaming={false}
                        isLast={i === lastIndex && !liveHere}
                        onRegenerate={regenerate}
                        onOpenSettings={() => setSettingsOpen(true)}
                        onUndo={m.changes?.length && !m.undone && chat ? () => undoReply(chat.id, m.id) : undefined}
                        onSave={(how) => saveReply(m, how)}
                      />
                    )}
                    {chat?.summary?.upto === m.id && <SummaryDivider summary={chat.summary} ai={ai} />}
                  </Fragment>
                ))}
                {liveHere && (
                  <AssistantBlock
                    message={liveHere}
                    streaming
                    status={chat ? lives[chat.id]?.status : null}
                    allowAuto={limits.auto && limits.edit}
                    isLast
                    onRegenerate={regenerate}
                    onOpenSettings={() => setSettingsOpen(true)}
                    onDecide={decide}
                    onApproveAll={approveAll}
                  />
                )}
                {chat &&
                  (queued[chat.id] ?? []).map((q) => (
                    <QueuedBubble
                      key={q.message.id}
                      message={q.message}
                      ai={ai}
                      busy={!!q.now}
                      onNow={() => answerTogether(chat.id)}
                      onCancel={() => cancelQueued(chat.id, q)}
                    />
                  ))}
              </div>
              </ProcsContext.Provider>
              </RunContext.Provider>
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
              <p className="mt-2 text-center text-[11px] text-faint">{ai} can make mistakes. Check important info.</p>
            </div>
          </>
        )}
      </main>

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        keyStatus={keyStatus}
        claudeKey={claudeKey}
        searchKey={searchKey}
        githubKey={githubKey}
        models={models}
        defaultSystemPrompt={defaultSystemPrompt}
        onKeysChanged={() => loadSettings().catch(() => {})}
        onSaved={(s) => {
          // A new default model applies to the chat you're starting (if you haven't sent it yet).
          if (!chatRef.current && s.defaultModel !== settings?.defaultModel) setDraftPrefs((p) => ({ ...p, ...newChatModel({ settings: s, key: keyStatus, claudeKey, models }) }));
          setSettings(s);
        }}
      />
      <ProjectDialog
        open={projectDialog.open}
        project={projectDialog.project}
        allowedRepos={settings?.githubRepos ?? []}
        platform={platform}
        defaultDocsFolder={settings?.docsFolder ?? ""}
        globalSkillsFolder={settings?.skillsFolder ?? ""}
        globalSkillsOff={settings?.skillsOff ?? []}
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
