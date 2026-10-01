# DeepSeek Chat

A personal, Claude-desktop-style chat app for the DeepSeek and Claude APIs. Put in either key (or both) and it works. It runs on your own computer (Mac or Windows) and only that computer can reach it.

**Quick reference for every command: [CHEATSHEET.md](CHEATSHEET.md)**

## Install and run

You need **Node.js 20.9 or newer** (the LTS version from [nodejs.org](https://nodejs.org)) and **Git**. The app opens in its own Chrome window (or Edge on Windows); without either, it opens in your default browser.

### First time

Do this once. Put the app somewhere permanent (not Downloads): the shortcut, the `deepseek-chat` command and your saved chats (in its `data` folder) all live there. A new terminal window starts in your user folder, which is a good place.

**Windows** (PowerShell or Command Prompt):

1. Get the code. This makes a `my_deek_sk_ui` folder:
   ```powershell
   git clone https://github.com/tobioj/my_deek_sk_ui.git
   cd my_deek_sk_ui
   ```
2. Install the app's packages. It takes a few minutes; the `npm warn` lines are normal:
   ```powershell
   npm ci
   ```
3. Add the `deepseek-chat` command and a **DeepSeek Chat** shortcut on your Desktop and Start menu:
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\windows\install.ps1
   ```
4. Close the window and open a new one (the command isn't available in the old window), then start the app:
   ```powershell
   deepseek-chat
   ```
   The first start builds the app. It takes a few minutes and only shows "Building the app…". **Don't close the window or press Ctrl + C**; the app opens by itself when it's ready.
5. In the app, open **Settings → AI providers** and paste your DeepSeek API key, your Claude API key, or both. They're stored encrypted with your Windows login.

**Mac** (Terminal):

1. Get the code:
   ```bash
   git clone https://github.com/tobioj/my_deek_sk_ui.git
   cd my_deek_sk_ui
   ```
2. Install the app's packages (a few minutes):
   ```bash
   npm ci
   ```
3. Add the `deepseek-chat` command and a **DeepSeek Chat** app (Spotlight, Launchpad, Dock):
   ```bash
   zsh scripts/mac/install.sh
   ```
4. Open a new Terminal window, then start the app:
   ```bash
   deepseek-chat
   ```
   The first start builds the app (a few minutes). Don't close the window or press Ctrl + C; the app opens by itself.
5. In the app, open **Settings → AI providers** and paste your DeepSeek API key, your Claude API key, or both. They're stored in the macOS Keychain.

### Every day (both systems)

| I want to… | Do this |
|---|---|
| Open the app | Run `deepseek-chat`, or open **DeepSeek Chat** (Desktop / Start menu on Windows, Spotlight on Mac) |
| Restart it | `deepseek-chat restart` (it rebuilds first if the code changed) |
| Stop it | `deepseek-chat stop` (also stops any commands it started) |
| Check whether it's running | `deepseek-chat status` (also lists running commands) |
| See what it's doing | `deepseek-chat logs` (Ctrl + C to leave) |

Closing the app window leaves the app running in the background, so it reopens instantly. Commands you or DeepSeek started keep running too, in the app's Running list. `deepseek-chat stop` stops everything.

### Getting updates (both systems)

In a terminal, go to the app folder (`cd my_deek_sk_ui` from your user folder), then run these four commands in order:

```bash
deepseek-chat stop
git pull
npm ci
deepseek-chat
```

1. `deepseek-chat stop` stops the app. On Windows it must be stopped first, or `npm ci` fails because the app's files are in use.
2. `git pull` downloads the latest code.
3. `npm ci` updates the app's packages to match. It's safe to run every time.
4. `deepseek-chat` rebuilds the app with the new code (a few minutes; don't close the window) and opens it.

### Moving to a new folder (for example from a ZIP download)

A ZIP download can't get updates with `git pull`, so clone the app as above instead. To keep your chats, projects, skills and settings (and, on Windows, your saved keys), copy them across:

1. Stop the old copy: in the old folder, run `deepseek-chat stop` (or `scripts\windows\deepseek-chat.cmd stop` on Windows if the command isn't set up).
2. Copy the old folder's `data` folder into the new `my_deek_sk_ui` folder.
3. Run the first-time steps in the new folder. The setup points the shortcut and the command at the new folder.

The same works for moving to another computer: copy the `data` folder over. Keys don't travel (they're tied to the computer), so paste them again in Settings there.

### If something goes wrong

| Problem | Fix |
|---|---|
| `'deepseek-chat' is not recognized` (Windows) | Run step 3 of the first-time setup, then close every terminal window (Windows Terminal completely, since new tabs keep the old settings) and open a new one. Or, from the app folder, run `scripts\windows\deepseek-chat.cmd`. |
| `command not found: deepseek-chat` (Mac) | Run `zsh scripts/mac/install.sh`, then open a new Terminal window |
| You pressed Ctrl + C during "Building the app…" | Run `deepseek-chat` again: it sees the build didn't finish and starts it over |
| `npm start` says "Could not find a production build" | The app hasn't been built. Use `deepseek-chat`, or run `npm run build` first (see below) |
| `npm ci` fails with "EPERM" or "EBUSY" (Windows) | The app is still running: `deepseek-chat stop`, then `npm ci` again |
| The build failed | The details are in `data\build.log` (Windows) or `data/build.log` (Mac) |

### Without `deepseek-chat` (Mac or Windows)

```bash
npm ci
npm run build
npm start
```

Then open http://127.0.0.1:3456. It runs only while that terminal stays open (Ctrl + C stops it, along with any commands it started), and you need `npm run build` again after every update.

| Command | What it does |
|---|---|
| `npm ci` | Installs exactly the package versions in `package-lock.json` (a clean install) |
| `npm run build` | Builds the app. Needed before `npm start`, and after every update |
| `npm start` | Runs the built app at http://127.0.0.1:3456 |
| `npm run dev` | Development version with live reload at http://127.0.0.1:3455 |

## Your API keys

You need at least one: **DeepSeek** (platform.deepseek.com → API keys) or **Claude** (console.anthropic.com → API keys; billed per use, separately from a Claude.ai plan). Add them in **Settings → AI providers → Save key**; each is tested right away. **Remove** deletes a key from this computer (your chats are kept).

Keys are stored on this computer only: in the macOS Keychain on a Mac, encrypted with your Windows login on Windows. They're never put in a file and never sent to the browser, and the Claude key only ever goes to Anthropic. On the Mac you can also set them in Terminal (it asks you to paste the key):

```bash
security add-generic-password -U -a "$USER" -s deepseek-api-key -w
security add-generic-password -U -a "$USER" -s anthropic-api-key -w
```

The `deepseek` terminal command (Claude Code running on DeepSeek) uses the same DeepSeek Keychain entry.

## What you can do

| | |
|---|---|
| **Attach files** | Drag them anywhere onto the window, paste them, or use **+ → Upload files**. Text, code, images (V4.1 Flash can see them), PDFs and Word docs. |
| **Attach a folder** | Drag a folder in, or **+ → Add a folder…** to get a checklist of its files. `node_modules`, `.git`, builds and binaries are skipped automatically, and `.env` files are always blocked. |
| **Let DeepSeek explore a project** | **+ → Add a folder… → Let DeepSeek explore it.** DeepSeek then lists, reads and searches the files it needs by itself (read-only), just like Claude Code. |
| **@-mention a file** | With a project folder open, type `@` and pick a file to attach it. |
| **Thinking** | The **Think** button turns step-by-step reasoning on or off; the model menu sets the effort (DeepSeek: High / Max; Claude: Low to Max, depending on the model). The newest Opus and Fable always think. |
| **Web search** | Off by default. Turn it on in **Settings → Web search** and add a free [Tavily](https://app.tavily.com) key (1,000 searches a month). A **Search** button then appears next to Think; when it's on, DeepSeek can search the web, read pages and cite sources. |
| **Ask / Plan / Edit / Auto** | With a folder open: **Ask** reads and answers. **Plan** writes a step-by-step plan without changing anything. **Edit** changes files, with a before/after preview and Approve/Reject for every change. **Auto** makes all the changes without asking. Every reply's changes can be undone. |
| **Docs folder** | DeepSeek can create and update documents there in any mode (it asks first, or not, per doc). Settings sets the default; projects can set their own. |
| **Terminal** | Per project, off by default. DeepSeek runs commands in the project's folders: look-only ones straight away, others after you click **Run** (or without asking in Auto mode on the Mac). On the Mac they run in a sandbox (only the project folders are writable; keys, logins and the Keychain are unreadable; internet off unless you allow it). On Windows there's no sandbox, so every command but look-only ones asks. Code blocks get a free **▶ Run** button, and the **Running** list shows and stops everything still running. GitHub stays read-only. |
| **Save a reply** | **Save** under any reply writes it to a file you pick in the Mac's Save dialog. |
| **GitHub (read-only)** | Fine-grained token, repos you tick in Settings, repos picked per project, and a GitHub button per chat (off by default). Reads code, issues, PRs, commits and CI; can't change anything. |
| **Projects** | Group chats in the sidebar. Each project has shared context, shared files, **folders linked to every chat in it**, and a memory setting (*Project + global* or *This project only*). Chats can switch off a project folder or add their own. |
| **Several folders** | Link as many folders as you like to a chat or project. DeepSeek sees each by name (`backend/src/app.py`, `web/src/App.tsx`) and can search, read and edit across all of them. |
| **Models** | DeepSeek **V4.1 Flash** (fast, cheap, sees images) or **V4 Pro** (smartest, text only), and every Claude model your key can use, from Haiku to Fable (the list comes from your key). Pick per chat in the model menu; **Settings → Defaults for new chats** sets which one new chats start with. |
| **Long chats** | Past 200K tokens (change it in **Settings → Long chats**; sooner for models with a smaller context), the earlier messages are summarized so the chat can keep going. **Summarize** in the token ring does it any time. Works for DeepSeek and Claude. |
| **Skills** | Instructions you keep for kinds of tasks (how you like reports written, a checklist, a template). Every AI opens the matching skill when a task needs it. See **Skills** below. |
| **Token meter** | The ring next to the model picker shows how full the conversation is, what it's cost so far, and what the next message will cost. |
| **Stop, edit, retry** | Stop a reply with the ■ button or **Esc**. Hover your message to edit and resend it. **Retry** regenerates the last reply. |
| **Send while it's replying** | Messages you send while DeepSeek is working go in at its next step, so it takes them into account in the same reply. **Answer together now** cuts off what it's writing and starts again with your message. Stop puts waiting messages back in the message box. |
| **Several chats at once** | Up to 4 chats can reply at the same time. The sidebar marks chats that are replying (blue) or waiting for your approval (amber), and warns you when two chats are editing the same folder. |
| **Saved chats** | Everything is saved automatically. Search, rename, export to Markdown or delete from the sidebar. |

Long pasted text (more than 4,000 characters) turns into an attachment, like in Claude.

### Claude

Everything above works with Claude too. A few things are Claude's own:

| | |
|---|---|
| **What Claude may do** | **Settings → AI providers → What Claude may do**: Read folders, Change files, Auto mode, Run commands, Read GitHub, Save to Docs, Web search, Code execution. **All off to start**; switch on what you want. DeepSeek has the same switches (minus Code execution), all on as before. Off means off: the matching buttons in chats are greyed out, whatever a project or chat says. |
| **Web search** | Claude's own search (no Tavily key needed): the **Search** button in a chat (greyed out until Web search is allowed). It also reads whole pages. $10 per 1,000 searches plus the pages it reads; **Settings → AI providers → Web search and safety options** caps the searches per reply (5 by default) and lists sites it must never use. |
| **Code execution** | The **Code** button (greyed out until Code execution is allowed). Claude runs Python in Anthropic's sandbox (not on your computer): calculations, charts, data files you attach (CSV, Excel). Files it makes, like charts, appear under the reply to download. |
| **PDFs and images** | Claude reads PDFs as they are (layout, tables, scans) and sees images. |
| **Declines** | If Claude's safety checks flag a harmless request, another Claude model can answer instead (on by default, in **Web search and safety options**); the reply says so. |
| **Costs** | Each reply shows what it cost, and the token ring shows the chat's total. Prices are in `lib/models.ts`. |

### Skills

A skill is a folder with a `SKILL.md` file: a short header with its name and a one-line description of when to use it, then the instructions. It can hold other files too (templates, examples). It's the same format Claude Code and Claude.ai use.

```
---
name: weekly-report
description: How I like my weekly status reports written
---
Keep it under a page. Start with wins, then blockers…
```

DeepSeek and Claude only see each skill's name and description, and open the full skill when a task matches, so you can keep many without paying for them in every message. They can only read skills; nothing in a skill runs.

| Where | What |
|---|---|
| **Your skills** (Settings → Skills) | Kept in the app's `data/skills` folder, so they move with it. **New skill** makes one from a template and opens it in your text editor; the pencil next to a skill opens it again. **Import folder…** and **Import .zip…** bring skills in (from Claude Code, Claude.ai or anywhere). **Open folder** shows them in Finder / File Explorer. Each skill has an on/off switch. |
| **A folder on this computer** (Settings → Skills, optional) | For example Claude Code's `~/.claude/skills` (one click). These stay on this computer; the copy button next to one copies it into your skills so it travels too. |
| **A project's own skills** (Project settings → Skills) | Kept with the project in the data folder (deleted with the project). |
| **Skills in a project's code** | Any `.claude/skills` folder inside the project's folders, found automatically. They travel with your code through Git, and Claude Code uses the same ones. Used when the AI may read the project's folders. |

In Project settings you can also switch off **Also use my skills** (off by default for *This project only* projects) and switch single skills off for that project. When two skills have the same name, the project's own wins, then the one in its code, then yours.

### Keyboard shortcuts

| Action | Keys |
|---|---|
| Send / new line | Enter / Shift + Enter |
| New chat | ⌘ ⇧ O |
| Search chats | ⌘ K |
| Toggle sidebar | ⌘ B |
| Stop reply | Esc |

## Where things are stored

Everything is in `data/` (ignored by Git): one JSON file per chat in `data/chats/`, projects in `data/projects/`, images, PDFs and files Claude made in `data/uploads/`, your skills in `data/skills/`, each project's own skills in `data/project-skills/`, settings in `data/settings.json`, and server logs in `data/server.log`. Copy the `data` folder to back everything up or move it to another computer (keys excepted).

## Safety

- The server only listens on `127.0.0.1` and rejects requests from other websites, so nothing else can use it to read your files. Don't deploy it publicly.
- In Ask and Plan mode, DeepSeek's folder access is **read-only**. In Edit mode, every change needs your approval; in Auto mode changes apply straight away. Either way, each reply's changes can be undone. Either way, it can't leave the folder you chose, including through symlinks, and it never touches `.git`, `node_modules` or secret files.
- `.env`, private keys and similar secret files are never read or attached, and never read from or copied into skills.
- Your Claude key is only ever sent to Anthropic (`api.anthropic.com`). The app ignores `ANTHROPIC_BASE_URL`, which tools like Claude Code (and the `deepseek` command) set for themselves.
- Claude's code execution runs in Anthropic's sandbox, never on your computer. It only gets the files you attach to that chat.
- Terminal commands only run in projects where you've switched Terminal on, only in the project's folders, and (on the Mac) inside the macOS sandbox. `sudo`, `git push`, `gh`, `curl … | sh` and background tricks like `&` never run; risky commands always ask. Closing the window doesn't stop running commands; `deepseek-chat stop` does.

## Developing

```bash
npm run dev        # http://127.0.0.1:3455 with hot reload
npm run typecheck
npm run lint
```

After changing code, `deepseek-chat restart` rebuilds and restarts the everyday app (it rebuilds automatically whenever the code is newer than the last build).

| File | Purpose |
|---|---|
| `app/api/chat/route.ts` | Sends the conversation to DeepSeek or Claude, runs the tools, streams the reply, saves it |
| `lib/access.ts` | What the AI may do in a chat: Settings and each provider's limits, then the project, then the chat |
| `lib/conversation.ts`, `lib/session.ts` | The instructions, and DeepSeek's message format and streaming |
| `lib/claude.ts`, `lib/claude-session.ts` | The Claude client, the model list from your key, Claude's message format, web search, code execution, files |
| `lib/summarize.ts` | Summarizing long chats (Claude's own, or written by the app) |
| `lib/skills.ts` | Skills: finding them, importing, the read-only skill tools |
| `lib/tools.ts`, `lib/files.ts` | Read-only folder tools and file access |
| `lib/folders.ts`, `lib/roots.ts` | Which folders a chat can use (project + chat, minus switched-off) and how `name/path` maps to disk |
| `lib/websearch.ts` | Web search tools (Tavily) |
| `lib/github.ts` | Read-only GitHub tools (GET requests only, checked against your allowlist) |
| `lib/docs.ts` | Docs folder tools |
| `lib/edits.ts`, `lib/approvals.ts` | Edit mode: file-change tools, previews, backups, undo, approvals |
| `lib/commands.ts` | Terminal rules: look-only, ask, always ask, never run |
| `lib/sandbox.ts`, `lib/processes.ts`, `lib/terminal.ts` | Running commands: the macOS sandbox profile, the Running list, DeepSeek's command tools |
| `lib/secrets.ts` | API keys in the macOS Keychain (or encrypted with your Windows login) |
| `lib/skip.ts` | Skip rules for junk folders, binaries and secrets |
| `lib/models.ts` | DeepSeek models, Claude prices, and the per-provider switches (update here if prices change) |
| `lib/tokens.ts` | DeepSeek prices and token estimates |
| `lib/types.ts` | The shapes of chats, projects and settings |
| `components/` | The interface |
