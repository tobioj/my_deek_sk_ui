"use client";
// Create or edit a project: a name, shared context every chat sees, shared files, folders,
// and whether DeepSeek may run commands in them (Terminal).
import { AlertTriangle, FileText, FolderOpen, Loader2, Paperclip, Plus, Trash2, X } from "lucide-react";
import { nanoid } from "nanoid";
import { useState } from "react";
import { api, fileToAttachment } from "@/lib/client";
import { formatTokens } from "@/lib/tokens";
import { baseName, projectFolders } from "@/lib/folders";
import type { Platform } from "@/lib/commands";
import type { Project, ProjectFile } from "@/lib/types";
import { Button, Modal, Segmented, Switch } from "./ui";

interface Props {
  open: boolean;
  project: Project | null; // null = creating a new project
  allowedRepos: string[]; // GitHub allowlist from Settings
  platform: Platform; // macOS gets the sandbox; Windows asks before every command
  defaultDocsFolder: string; // Docs folder from Settings
  onClose: () => void;
  onSaved: (p: Project) => void;
  onDelete: (id: string) => void;
}

export function ProjectDialog(props: Props) {
  if (!props.open) return null;
  return <ProjectForm key={props.project?.id ?? "new"} {...props} />;
}

function ProjectForm({ project, allowedRepos, platform, defaultDocsFolder, onClose, onSaved, onDelete }: Props) {
  const [name, setName] = useState(project?.name ?? "");
  const [context, setContext] = useState(project?.context ?? "");
  const [folders, setFolders] = useState<string[]>(projectFolders(project));
  const addFolder = (p: string) => setFolders((prev) => (prev.includes(p) ? prev : [...prev, p]));
  const [pathInput, setPathInput] = useState("");
  const [files, setFiles] = useState<ProjectFile[]>(project?.files ?? []);
  const [isolated, setIsolated] = useState(project?.isolated ?? false);
  const [docsFolder, setDocsFolder] = useState(project?.docsFolder ?? "");
  const [repos, setRepos] = useState<string[]>(project?.githubRepos ?? []);
  const [terminal, setTerminal] = useState(project?.terminal ?? false);
  const [internet, setInternet] = useState(project?.terminalInternet ?? false);
  const [minutes, setMinutes] = useState(String(project?.terminalMinutes ?? 10));
  const [allowed, setAllowed] = useState<string[]>(project?.allowedCommands ?? []);
  const [ruleInput, setRuleInput] = useState("");
  const addRule = () => {
    const r = ruleInput.trim();
    if (r && !allowed.includes(r)) setAllowed((prev) => [...prev, r]);
    setRuleInput("");
  };
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const addFiles = async (list: File[]) => {
    setBusy("files");
    setError(null);
    const added: ProjectFile[] = [];
    const problems: string[] = [];
    for (const f of list) {
      try {
        const a = await fileToAttachment(f);
        if (a.kind === "image" || typeof a.content !== "string") throw new Error(`${f.name}: images can't be project files`);
        added.push({ id: nanoid(10), name: f.name, content: a.content, size: a.content.length });
      } catch (e) {
        problems.push((e as Error).message);
      }
    }
    setFiles((prev) => [...prev, ...added]);
    if (problems.length) setError(problems.join(" · "));
    setBusy(null);
  };

  const browse = async () => {
    setBusy("browse");
    setError(null);
    try {
      const res = await api<{ path?: string }>("/api/folder/pick", { method: "POST" });
      if (res.path) addFolder(res.path);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy("save");
    setError(null);
    try {
      const body = {
        name: name.trim() || "Untitled project",
        context,
        folders,
        files,
        isolated,
        docsFolder: docsFolder.trim() || null,
        githubRepos: repos,
        terminal,
        terminalInternet: internet,
        terminalMinutes: Number(minutes),
        allowedCommands: allowed,
      };
      const saved = project
        ? await api<Project>(`/api/projects/${project.id}`, { method: "PATCH", json: body })
        : await api<Project>("/api/projects", { method: "POST", json: body });
      onSaved(saved);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const tokens = Math.ceil((context.length + files.reduce((n, f) => n + f.size, 0)) / 4);

  return (
    <Modal
      open
      onClose={onClose}
      title={project ? "Project settings" : "New project"}
      width="max-w-xl"
      footer={
        <>
          {project && (
            <Button
              variant={confirmDelete ? "danger" : "ghost"}
              className="mr-auto"
              onClick={() => {
                if (!confirmDelete) return setConfirmDelete(true);
                onDelete(project.id);
                onClose();
              }}
            >
              <Trash2 size={13} /> {confirmDelete ? "Click again to delete" : "Delete project"}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={!!busy}>
            {busy === "save" && <Loader2 size={14} className="animate-spin" />}
            {project ? "Save" : "Create project"}
          </Button>
        </>
      }
    >
      <div
        className="space-y-5"
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          addFiles(Array.from(e.dataTransfer.files));
        }}
      >
        <label className="block">
          <span className="mb-1.5 block text-[13px] font-medium">Name</span>
          <input
            autoFocus={!project}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Okec backend, Thesis, Job search"
            className="h-9 w-full rounded-lg border border-line bg-app px-3 text-[14px] outline-none focus:border-line-strong"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-[13px] font-medium">Project context</span>
          <span className="mb-1.5 block text-xs text-muted">
            Every chat in this project sees this. Describe the project, your goals, conventions, and how you want DeepSeek to respond.
          </span>
          <textarea
            value={context}
            onChange={(e) => setContext(e.target.value)}
            rows={7}
            placeholder={"e.g. This is a FastAPI + PostgreSQL backend for a delivery app. We use Alembic for migrations and pytest for tests.\nKeep answers short and show code in Python 3.12."}
            className="w-full resize-y rounded-lg border border-line bg-app px-3 py-2 text-[13.5px] leading-relaxed outline-none focus:border-line-strong"
          />
        </label>

        <div>
          <span className="mb-1 block text-[13px] font-medium">Memory</span>
          <span className="mb-2 block text-xs text-muted">
            Chats never see each other. This decides whether your global instructions from Settings also apply here.
          </span>
          <div className="grid grid-cols-2 gap-2">
            {[
              { value: false, title: "Project + global", body: "This project's context, plus your instructions from Settings." },
              { value: true, title: "This project only", body: "Only this project's context. Your Settings instructions are ignored." },
            ].map((o) => (
              <button
                key={String(o.value)}
                type="button"
                onClick={() => setIsolated(o.value)}
                className={`rounded-xl border px-3 py-2 text-left transition-colors ${
                  isolated === o.value ? "border-accent bg-accent-soft" : "border-line hover:bg-hover"
                }`}
              >
                <div className={`text-[13px] font-medium ${isolated === o.value ? "text-accent" : ""}`}>{o.title}</div>
                <div className="text-[11.5px] leading-snug text-muted">{o.body}</div>
              </button>
            ))}
          </div>
        </div>

        <div>
          <span className="mb-1 block text-[13px] font-medium">Folders (optional)</span>
          <span className="mb-1.5 block text-xs text-muted">
            Your codebase. Linked to every chat in this project, so DeepSeek can explore it and read only the files it needs. Add as many as you
            like (e.g. backend and frontend). A chat can switch one off, or add its own.
          </span>
          {folders.length > 0 && (
            <div className="mb-2 divide-y divide-line rounded-lg border border-line bg-app">
              {folders.map((f) => (
                <div key={f} className="flex items-center gap-2 px-3 py-2 text-[13px]">
                  <FolderOpen size={14} className="shrink-0 text-accent" />
                  <span className="shrink-0 font-medium">{baseName(f)}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-faint" title={f}>
                    {f}
                  </span>
                  <button
                    type="button"
                    onClick={() => setFolders((prev) => prev.filter((x) => x !== f))}
                    className="rounded p-0.5 text-muted hover:text-fg"
                    aria-label={`Remove ${f}`}
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <Button onClick={browse} disabled={!!busy}>
              {busy === "browse" ? <Loader2 size={14} className="animate-spin" /> : <FolderOpen size={14} />}
              {folders.length ? "Add another folder…" : "Choose folder…"}
            </Button>
            <input
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && pathInput.trim()) {
                  e.preventDefault();
                  addFolder(pathInput.trim());
                  setPathInput("");
                }
              }}
              placeholder="…or type a path and press Enter"
              className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-app px-3 font-mono text-[12.5px] outline-none focus:border-line-strong"
            />
          </div>
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between gap-3">
            <span className="text-[13px] font-medium">Terminal</span>
            <Switch checked={terminal} onChange={setTerminal} label="Let DeepSeek run commands in this project's folders" disabled={!folders.length} />
          </div>
          <span className="block text-xs text-muted">
            {!folders.length
              ? "Add a folder above first: commands only ever run in this project's folders."
              : platform === "mac"
                ? "Let DeepSeek run commands in this project's folders, in a sandbox: they can only change files in these folders, can't read your SSH keys, logins or Keychain, and can't push to GitHub. Look-only commands (ls, git status…) run straight away; others ask first, except in Auto mode."
                : "Let DeepSeek run commands in this project's folders. Windows has no sandbox, so every command except look-only ones (dir, git status…) asks you first, even in Auto mode. Nothing can push to GitHub."}{" "}
            Code blocks in replies also get a ▶ Run button.
          </span>
          {terminal && folders.length > 0 && (
            <div className="mt-2.5 space-y-3 rounded-lg border border-line bg-app px-3 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[13px]">Internet for commands</div>
                  <div className="text-[11.5px] text-muted">
                    {platform === "mac"
                      ? "Needed for npm install, pip install, git pull. Off means commands can only reach this computer (localhost)."
                      : "Can't be blocked on Windows without a sandbox: commands you approve can always reach the internet."}
                  </div>
                </div>
                <Switch checked={platform === "mac" ? internet : true} onChange={setInternet} label="Internet for commands" disabled={platform !== "mac"} />
              </div>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[13px]">Time limit</div>
                  <div className="text-[11.5px] text-muted">For each command DeepSeek runs. Background servers and your ▶ Run commands have no limit.</div>
                </div>
                <Segmented
                  value={minutes}
                  onChange={setMinutes}
                  options={[
                    { value: "10", label: "10 min" },
                    { value: "30", label: "30 min" },
                    { value: "60", label: "60 min" },
                  ]}
                />
              </div>
              <div>
                <div className="text-[13px]">Always allowed</div>
                <div className="mb-1.5 text-[11.5px] text-muted">
                  Commands starting with these run without asking in Edit and Auto mode. Added from a command&apos;s card with &ldquo;Always allow&rdquo;.
                </div>
                {allowed.length > 0 && (
                  <div className="mb-1.5 divide-y divide-line rounded-lg border border-line bg-surface">
                    {allowed.map((r) => (
                      <div key={r} className="flex items-center gap-2 px-3 py-1.5">
                        <code className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{r}</code>
                        <button
                          type="button"
                          onClick={() => setAllowed((prev) => prev.filter((x) => x !== r))}
                          className="rounded p-0.5 text-muted hover:text-fg"
                          aria-label={`Stop always allowing ${r}`}
                        >
                          <X size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex gap-2">
                  <input
                    value={ruleInput}
                    onChange={(e) => setRuleInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addRule();
                      }
                    }}
                    placeholder="e.g. npm test"
                    className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 font-mono text-[12.5px] outline-none focus:border-line-strong"
                  />
                  <Button onClick={addRule} disabled={!ruleInput.trim()}>
                    <Plus size={13} /> Add
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>

        <div>
          <span className="mb-1 block text-[13px] font-medium">Docs folder (optional)</span>
          <span className="mb-1.5 block text-xs text-muted">
            Where DeepSeek saves documents for this project, in any mode. Empty = the default from Settings
            {defaultDocsFolder ? ` (${defaultDocsFolder})` : " (currently off)"}. Tip: a <span className="font-mono">docs</span> folder inside your
            codebase keeps plans next to the code.
          </span>
          <div className="flex gap-2">
            <input
              value={docsFolder}
              onChange={(e) => setDocsFolder(e.target.value)}
              placeholder={defaultDocsFolder ? `Default: ${defaultDocsFolder}` : "e.g. ~/Documents/Okec docs"}
              className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-app px-3 font-mono text-[12.5px] outline-none focus:border-line-strong"
            />
            <Button
              onClick={async () => {
                const res = await api<{ path?: string }>("/api/folder/pick", { method: "POST" }).catch(() => ({ path: undefined }));
                if (res.path) setDocsFolder(res.path);
              }}
            >
              <FolderOpen size={14} /> Choose…
            </Button>
          </div>
        </div>

        <div>
          <span className="mb-1 block text-[13px] font-medium">GitHub repos (read-only)</span>
          {allowedRepos.length ? (
            <>
              <span className="mb-1.5 block text-xs text-muted">Which of your allowed repos this project&apos;s chats may read. None ticked = no GitHub in this project.</span>
              <div className="max-h-40 divide-y divide-line overflow-y-auto rounded-lg border border-line">
                {allowedRepos.map((r) => (
                  <label key={r} className="flex cursor-pointer items-center gap-2.5 px-3 py-1.5 text-[13px] hover:bg-hover">
                    <input
                      type="checkbox"
                      checked={repos.includes(r)}
                      onChange={() => setRepos((prev) => (prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r]))}
                      className="accent-[var(--accent)]"
                    />
                    <span className="font-mono text-[12.5px]">{r}</span>
                  </label>
                ))}
              </div>
            </>
          ) : (
            <span className="block text-xs text-muted">Set up GitHub in Settings first, then pick this project&apos;s repos here.</span>
          )}
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[13px] font-medium">Project files (optional)</span>
            <label className="inline-flex cursor-pointer items-center gap-1 text-[12.5px] text-accent hover:underline">
              <Paperclip size={13} /> Add files
              <input
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  addFiles(Array.from(e.target.files ?? []));
                  e.target.value = "";
                }}
              />
            </label>
          </div>
          <span className="mb-1.5 block text-xs text-muted">
            Documents DeepSeek should always keep in mind (specs, notes, a style guide). Their full text goes with every message, so keep them
            small. Drag them here, or click Add files.
          </span>
          {files.length > 0 ? (
            <div className="divide-y divide-line rounded-lg border border-line">
              {files.map((f) => (
                <div key={f.id} className="flex items-center gap-2 px-3 py-1.5 text-[13px]">
                  <FileText size={13} className="shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 truncate">{f.name}</span>
                  <span className="shrink-0 text-[11.5px] text-faint">{formatTokens(Math.ceil(f.size / 4))} tokens</span>
                  <button
                    type="button"
                    onClick={() => setFiles((prev) => prev.filter((x) => x.id !== f.id))}
                    className="rounded p-0.5 text-muted hover:text-fg"
                    aria-label={`Remove ${f.name}`}
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-[12.5px] text-faint">
              {busy === "files" ? "Reading…" : "No files yet"}
            </div>
          )}
        </div>

        {tokens > 0 && (
          <p className="text-xs text-muted">
            Context and files add about {formatTokens(tokens)} tokens to every message in this project. Repeated context is cached, so it
            costs about 50× less after the first message.
          </p>
        )}
        {error && (
          <div className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" /> {error}
          </div>
        )}
      </div>
    </Modal>
  );
}
