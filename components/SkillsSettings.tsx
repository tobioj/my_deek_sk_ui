"use client";
// Skills in Settings (your skills, kept in the data folder, plus an optional folder on this computer)
// and in Project settings (the project's own skills, skills in its code, and whether yours apply).
// Every AI uses them the same way. Skills are written in your text editor.
import { AlertTriangle, Copy, FileArchive, FolderInput, FolderOpen, Loader2, Pencil, Plus, RefreshCw, Sparkles } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "@/lib/client";
import { skillKey, type Settings, type SkillInfo } from "@/lib/types";
import { Button, Fold, FoldSection, Switch } from "./ui";

type Found = { folder: string; exists: boolean; skills: SkillInfo[] };

// Looks the skills up again when you come back to the app (e.g. after saving a skill in your editor).
function useRefresh() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const again = () => setTick((n) => n + 1);
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, []);
  return { tick, refresh: () => setTick((n) => n + 1) };
}

// The skills from one GET /api/skills query (null = none). Typed folders are looked up shortly
// after you stop typing.
function useFound(query: string | null, typed = false) {
  const [found, setFound] = useState<Found | null>(null);
  const [loading, setLoading] = useState(false);
  const { tick, refresh } = useRefresh();
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(
      () => {
        if (!query) return setFound(null);
        setLoading(true);
        api<Found>(`/api/skills?${query}`)
          .then((r) => !cancelled && setFound(r))
          .catch(() => !cancelled && setFound({ folder: query, exists: false, skills: [] }))
          .finally(() => !cancelled && setLoading(false));
      },
      typed && query ? 300 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, typed, tick]);
  return { found: query ? found : null, loading, refresh };
}

// Skills in .claude/skills inside each of a project's folders.
function useCodeSkills(folders: string[]) {
  const key = folders.join("\n");
  const [groups, setGroups] = useState<{ folder: string; skills: SkillInfo[] }[]>([]);
  const { tick, refresh } = useRefresh();
  useEffect(() => {
    let cancelled = false;
    const list = key ? key.split("\n") : [];
    Promise.all(
      list.map((f) =>
        api<Found>(`/api/skills?code=${encodeURIComponent(f)}`)
          .then((r) => ({ folder: f, skills: r.skills }))
          .catch(() => ({ folder: f, skills: [] })),
      ),
    ).then((g) => !cancelled && setGroups(g));
    return () => {
      cancelled = true;
    };
  }, [key, tick]);
  return { groups: key ? groups : [], refresh };
}

const editSkill = (dir: string) => api("/api/skills", { method: "POST", json: { action: "edit", dir } });

function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" title={title} aria-label={title} onClick={onClick} className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted hover:bg-hover hover:text-fg">
      {children}
    </button>
  );
}

function SkillRows({
  skills,
  off,
  onToggle,
  actions,
}: {
  skills: SkillInfo[];
  off: string[]; // names, lowercase
  onToggle: (name: string, on: boolean) => void;
  actions?: (s: SkillInfo) => ReactNode;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <div>
      <div className="max-h-56 divide-y divide-line overflow-y-auto rounded-lg border border-line">
        {skills.map((s) => (
          <div key={s.dir} className="flex items-center gap-2 py-1.5 pl-3 pr-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-[13px] font-medium">
                <span className="truncate">{s.name}</span>
                {s.problem && (
                  <span title={s.problem} className="shrink-0 text-warn">
                    <AlertTriangle size={12} />
                  </span>
                )}
              </div>
              <div className="truncate text-[11.5px] text-muted" title={`${s.description}\n${s.dir}`}>
                {s.problem && s.description ? `${s.problem} · ${s.description}` : s.description || s.problem || s.rel}
              </div>
            </div>
            {actions?.(s)}
            <IconButton title={`Edit ${s.name} in your text editor`} onClick={() => editSkill(s.dir).catch((e) => setProblem((e as Error).message))}>
              <Pencil size={13} />
            </IconButton>
            <Switch checked={!off.includes(skillKey(s.name))} onChange={(v) => onToggle(s.name, v)} label={`Use the ${s.name} skill`} />
          </div>
        ))}
      </div>
      {problem && <p className="mt-1 text-xs text-danger">{problem}</p>}
    </div>
  );
}

const toggleIn = (list: string[], name: string, on: boolean) => {
  const k = skillKey(name);
  return on ? list.filter((n) => n !== k) : [...new Set([...list, k])];
};

const listNames = (names: string[]) => (names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.join(", "));

// New skill / Import / Open folder, for your skills or a project's own.
function LibraryTools({ project, onChanged }: { project?: string; onChanged: () => void }) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);
  const zipInput = useRef<HTMLInputElement>(null);

  const run = async (what: string, job: () => Promise<string | null>) => {
    setBusy(what);
    setMessage(null);
    try {
      const text = await job();
      if (text) setMessage({ text });
      onChanged();
    } catch (e) {
      setMessage({ text: (e as Error).message, bad: true });
    } finally {
      setBusy(null);
    }
  };
  const imported = (r: { added: string[]; skipped: string[] }) =>
    [r.added.length ? `Added ${listNames(r.added)}.` : "Nothing new to add.", r.skipped.length ? `Already had ${listNames(r.skipped)}.` : ""].filter(Boolean).join(" ");

  const create = () =>
    run("new", async () => {
      const made = await api<{ name: string; dir: string }>("/api/skills", { method: "POST", json: { action: "new", name, project } });
      setNaming(false);
      setName("");
      await editSkill(made.dir).catch(() => {});
      return `Created ${made.name} and opened it in your text editor. Fill it in and save; it updates here when you come back.`;
    });
  const importFolder = () =>
    run("folder", async () => {
      const picked = await api<{ path?: string }>("/api/folder/pick", { method: "POST" });
      if (!picked.path) return null;
      return imported(await api("/api/skills", { method: "POST", json: { action: "import", path: picked.path, project } }));
    });
  const importZip = (file: File) =>
    run("zip", async () => {
      const res = await fetch(`/api/skills${project ? `?project=${encodeURIComponent(project)}` : ""}`, {
        method: "POST",
        headers: { "Content-Type": "application/zip" },
        body: file,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Couldn't import it");
      return imported(data);
    });
  const spin = (what: string, icon: ReactNode) => (busy === what ? <Loader2 size={13} className="animate-spin" /> : icon);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setNaming((v) => !v)} disabled={!!busy}>
          <Plus size={13} /> New skill
        </Button>
        <Button onClick={importFolder} disabled={!!busy}>
          {spin("folder", <FolderInput size={13} />)} Import folder…
        </Button>
        <Button onClick={() => zipInput.current?.click()} disabled={!!busy}>
          {spin("zip", <FileArchive size={13} />)} Import .zip…
        </Button>
        <Button variant="ghost" onClick={() => run("reveal", async () => (await api("/api/skills", { method: "POST", json: { action: "reveal", project } }), null))} disabled={!!busy}>
          <FolderOpen size={13} /> Open folder
        </Button>
        <input
          ref={zipInput}
          type="file"
          accept=".zip,.skill"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) importZip(f);
          }}
        />
      </div>
      {naming && (
        <div className="flex gap-2">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim()) create();
              if (e.key === "Escape") setNaming(false);
            }}
            placeholder="Its name, e.g. weekly-report"
            aria-label="New skill name"
            className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-app px-3 font-mono text-[12.5px] outline-none focus:border-line-strong"
          />
          <Button variant="primary" onClick={create} disabled={!name.trim() || !!busy}>
            {spin("new", null)} Create
          </Button>
        </div>
      )}
      {message && <p className={message.bad ? "text-xs text-danger" : "text-xs text-muted"}>{message.text}</p>}
    </div>
  );
}

// A folder field with Choose…
function FolderField({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex gap-2">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label="Skills folder on this computer"
        className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-app px-3 font-mono text-[12.5px] outline-none focus:border-line-strong"
      />
      <Button
        onClick={async () => {
          setBusy(true);
          const r = await api<{ path?: string }>("/api/folder/pick", { method: "POST" }).catch(() => ({ path: undefined }));
          setBusy(false);
          if (r.path) onChange(r.path);
        }}
        disabled={busy}
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <FolderOpen size={14} />} Choose…
      </Button>
    </div>
  );
}

function FolderState({ found, loading, refresh }: { found: Found | null; loading: boolean; refresh: () => void }) {
  return (
    <div className="flex items-center justify-between text-xs text-muted">
      <span>
        {!found
          ? "Looking for skills…"
          : !found?.exists
            ? "That folder isn't on this computer."
            : found.skills.length
              ? `${found.skills.length} skill${found.skills.length === 1 ? "" : "s"} found`
              : "No skills found: each skill is a folder with a SKILL.md file in it."}
      </span>
      <button type="button" onClick={refresh} className="inline-flex items-center gap-1 hover:text-fg">
        <RefreshCw size={12} className={loading ? "animate-spin" : ""} /> Rescan
      </button>
    </div>
  );
}

function Heading({ title, hint }: { title: string; hint: ReactNode }) {
  return (
    <div>
      <div className="text-[13px] font-medium">{title}</div>
      <div className="text-[11.5px] text-muted">{hint}</div>
    </div>
  );
}

const HOW = (
  <>
    A skill is a folder with a <span className="font-mono">SKILL.md</span> file: a short header with its <b>name</b> and a one-line{" "}
    <b>description</b> (when to use it), then the instructions, your preferences, a checklist, a template… It can hold other files too (examples,
    templates) that the instructions point to.
    <pre className="my-1.5 whitespace-pre-wrap rounded-lg bg-code px-3 py-2 font-mono text-[11.5px] text-fg/80">
      {"---\nname: weekly-report\ndescription: How I like my weekly status reports written\n---\nKeep it under a page. Start with wins, then blockers…"}
    </pre>
    DeepSeek and Claude only see each skill&apos;s name and description, and open the full instructions when a task matches, so you can keep
    many skills without paying for them in every message. They can only read skills, in any mode; nothing in a skill runs.
    <br />
    <br />
    <b>Your skills</b> are kept in the app&apos;s data folder (<span className="font-mono">data/skills</span>), so they come along when you copy
    that folder to another computer. Write and change them in your text editor with <b>New skill</b> and the pencil buttons. It&apos;s the same
    format Claude Code and Claude.ai use, so you can import skills from either.
  </>
);

// Settings → Skills: your skills (in the data folder) plus, optionally, a folder on this computer.
export function SkillsSection({ draft, setDraft }: { draft: Settings; setDraft: (s: Settings) => void }) {
  const mine = useFound("library=1");
  const extra = useFound(draft.skillsFolder.trim() ? `folder=${encodeURIComponent(draft.skillsFolder.trim())}` : null, true);
  const [claudeCode, setClaudeCode] = useState<string | null>(null);
  const [copyNote, setCopyNote] = useState<string | null>(null);
  useEffect(() => {
    api<{ claudeCode: string | null }>("/api/skills")
      .then((r) => setClaudeCode(r.claudeCode))
      .catch(() => {});
  }, []);
  const all = [...(mine.found?.skills ?? []), ...(extra.found?.skills ?? [])];
  const on = all.filter((s) => !draft.skillsOff.includes(skillKey(s.name))).length;
  const toggle = (name: string, v: boolean) => setDraft({ ...draft, skillsOff: toggleIn(draft.skillsOff, name, v) });
  const haveNames = new Set((mine.found?.skills ?? []).map((s) => skillKey(s.name)));
  const home = (p: string) => p.replace(/^\/Users\/[^/]+|^C:\\Users\\[^\\]+/i, "~");
  return (
    <FoldSection id="settings-skills" title="Skills" icon={<Sparkles size={15} />} summary={all.length ? `${on} of ${all.length} on` : "None yet"}>
      <Fold label="How skills work">{HOW}</Fold>

      <Heading title="Your skills" hint="Kept in the app's data folder, so they move with it to another computer." />
      <LibraryTools onChanged={mine.refresh} />
      {mine.found?.skills.length ? (
        <SkillRows skills={mine.found.skills} off={draft.skillsOff} onToggle={toggle} />
      ) : (
        <p className="text-xs text-muted">No skills yet. Click New skill to write one, or import some.</p>
      )}

      <div className="border-t border-line pt-3">
        <Heading title="Also use a folder on this computer (optional)" hint="For example the skills you have in Claude Code. They stay on this computer; copy one into your skills to take it with you." />
      </div>
      <FolderField value={draft.skillsFolder} onChange={(v) => setDraft({ ...draft, skillsFolder: v })} placeholder="e.g. ~/.claude/skills (empty = none)" />
      {claudeCode && home(draft.skillsFolder.trim()) !== home(claudeCode) && draft.skillsFolder.trim() !== claudeCode && (
        <button type="button" onClick={() => setDraft({ ...draft, skillsFolder: "~/.claude/skills" })} className="text-left text-[12px] text-accent hover:underline">
          Use the skills you have in Claude Code (~/.claude/skills)
        </button>
      )}
      {draft.skillsFolder.trim() && <FolderState found={extra.found} loading={extra.loading} refresh={extra.refresh} />}
      {!!extra.found?.skills.length && (
        <SkillRows
          skills={extra.found.skills}
          off={draft.skillsOff}
          onToggle={toggle}
          actions={(s) =>
            haveNames.has(skillKey(s.name)) ? (
              <span className="shrink-0 px-1 text-[11px] text-faint">In your skills</span>
            ) : (
              <IconButton
                title={`Copy ${s.name} into your skills (so it moves with your data folder)`}
                onClick={() =>
                  api<{ added: string[] }>("/api/skills", { method: "POST", json: { action: "import", path: s.dir } })
                    .then((r) => {
                      setCopyNote(r.added.length ? `Copied ${s.name} into your skills.` : `You already have ${s.name}.`);
                      mine.refresh();
                    })
                    .catch((e) => setCopyNote((e as Error).message))
                }
              >
                <Copy size={13} />
              </IconButton>
            )
          }
        />
      )}
      {copyNote && <p className="text-xs text-muted">{copyNote}</p>}
      <p className="text-[11.5px] text-faint">
        Projects can have their own skills, and use the skills in their code (<span className="font-mono">.claude/skills</span>), in Project settings.
      </p>
    </FoldSection>
  );
}

// Project settings → Skills: whether your skills apply, the project's own, and the ones in its code.
export function ProjectSkillsSection({
  projectId,
  folders,
  useGlobal,
  setUseGlobal,
  off,
  setOff,
  globalFolder,
  globalOff,
}: {
  projectId: string | null; // null = not saved yet
  folders: string[]; // the project's folders (for .claude/skills)
  useGlobal: boolean;
  setUseGlobal: (v: boolean) => void;
  off: string[]; // names switched off in this project
  setOff: (v: string[]) => void;
  globalFolder: string; // Settings' extra folder
  globalOff: string[]; // names switched off in Settings
}) {
  const mine = useFound(useGlobal ? "library=1" : null);
  const extra = useFound(useGlobal && globalFolder.trim() ? `folder=${encodeURIComponent(globalFolder.trim())}` : null);
  const own = useFound(projectId ? `project=${encodeURIComponent(projectId)}` : null);
  const code = useCodeSkills(folders);
  const yours = [...(mine.found?.skills ?? []), ...(extra.found?.skills ?? [])].filter((s) => !globalOff.includes(skillKey(s.name)));
  const codeSkills = code.groups.flatMap((g) => g.skills);
  const all = [...yours, ...codeSkills, ...(own.found?.skills ?? [])];
  const active = new Set(all.filter((s) => !off.includes(skillKey(s.name))).map((s) => skillKey(s.name))).size;
  const toggle = (name: string, v: boolean) => setOff(toggleIn(off, name, v));
  const folderName = (f: string) => f.split(/[\\/]/).filter(Boolean).pop() ?? f;
  return (
    <FoldSection id="project-skills" title="Skills" icon={<Sparkles size={15} />} summary={all.length ? `${active} on` : "None"}>
      <Fold label="How skills work">{HOW}</Fold>

      <div className="flex items-center justify-between gap-3">
        <Heading title="Also use my skills" hint="Your skills from Settings" />
        <Switch checked={useGlobal} onChange={setUseGlobal} label="Also use my skills" />
      </div>
      {useGlobal && yours.length > 0 && <SkillRows skills={yours} off={off} onToggle={toggle} />}

      <div className="border-t border-line pt-3">
        <Heading title="This project's own skills" hint="Kept with the project in the app's data folder." />
      </div>
      {projectId ? (
        <>
          <LibraryTools project={projectId} onChanged={own.refresh} />
          {!!own.found?.skills.length && <SkillRows skills={own.found.skills} off={off} onToggle={toggle} />}
        </>
      ) : (
        <p className="text-xs text-muted">Save the project first, then add its own skills here.</p>
      )}

      <div className="border-t border-line pt-3">
        <Heading
          title="Skills in this project's code"
          hint={
            <>
              Any <span className="font-mono">.claude/skills</span> folder inside the project&apos;s folders. They travel with your code, and Claude Code
              uses the same ones.
            </>
          }
        />
      </div>
      {!folders.length ? (
        <p className="text-xs text-muted">Add a folder to the project to use the skills in its code.</p>
      ) : codeSkills.length ? (
        code.groups
          .filter((g) => g.skills.length)
          .map((g) => (
            <div key={g.folder} className="space-y-1">
              <div className="font-mono text-[11.5px] text-muted">{folderName(g.folder)}/.claude/skills</div>
              <SkillRows skills={g.skills} off={off} onToggle={toggle} />
            </div>
          ))
      ) : (
        <p className="text-xs text-muted">
          None found in <span className="font-mono">.claude/skills</span> inside this project&apos;s folders.
        </p>
      )}

      <p className="text-[11.5px] text-faint">
        When two skills have the same name, the project&apos;s own wins, then the one in its code, then yours. Skills in the code are used when the AI
        may use this project&apos;s folders (Settings → AI providers).
      </p>
    </FoldSection>
  );
}
