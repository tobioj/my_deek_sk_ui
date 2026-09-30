# DeepSeek Chat

A personal, Claude-desktop-style chat app for the DeepSeek API. It runs on your own computer (Mac or Windows) and only that computer can reach it.

**Quick reference for every command: [CHEATSHEET.md](CHEATSHEET.md)**

## Install and run

You need **Node.js 20.9 or newer** (the LTS version from [nodejs.org](https://nodejs.org)) and **Git**. The app opens in its own Chrome window (or Edge on Windows); without either, it opens in your default browser.

The everyday way to run it is the `deepseek-chat` command. It builds the app when the code has changed, runs it in the background, and opens its window. Its subcommands are the same on both systems:

| Command | What it does |
|---|---|
| `deepseek-chat` | Starts the app if needed and opens its window |
| `deepseek-chat status` | Shows whether it's running, and any commands still running |
| `deepseek-chat stop` | Stops every running command, then the app |
| `deepseek-chat restart` | Stops it, rebuilds if the code changed, starts it again |
| `deepseek-chat logs` | Shows the app's log live (Ctrl + C to leave) |

The first launch builds the app (about a minute). After that it opens instantly. Closing the window leaves the app running in the background so it reopens instantly (commands you started keep running too, in the app's Running list).

### Windows

**First time**, in PowerShell or Command Prompt. Put the app somewhere permanent (not Downloads): the shortcut, the command and your saved chats (in its `data` folder) all live there.

```powershell
git clone https://github.com/tobioj/my_deek_sk_ui.git
cd my_deek_sk_ui
npm ci
powershell -ExecutionPolicy Bypass -File scripts\windows\install.ps1
```

`install.ps1` adds a **DeepSeek Chat** shortcut to your Desktop and Start menu and the `deepseek-chat` command. Then open **DeepSeek Chat**, or run `deepseek-chat` in a **new** window. Paste your API key in **Settings**; it's stored encrypted with your Windows login.

- **"'deepseek-chat' is not recognized"**: the setup hasn't been run yet, or the window was open before it ran. Close every terminal window (Windows Terminal completely, since new tabs keep the old settings) and open a new one. Or, from the app folder, run the launcher directly: `scripts\windows\deepseek-chat.cmd`.
- If you downloaded the code as a ZIP instead of `git clone`, `git pull` won't work in that folder. Clone it to get updates.

**Getting updates** (stop the app first: Windows locks the files of a running app, so `npm ci` would fail):

```powershell
deepseek-chat stop
git pull
npm ci
deepseek-chat
```

### Mac

**First time**, in Terminal:

```bash
git clone https://github.com/tobioj/my_deek_sk_ui.git
cd my_deek_sk_ui
npm ci
zsh scripts/mac/install.sh
```

`install.sh` adds the `deepseek-chat` command (in `~/.local/bin`, linked to `scripts/mac/deepseek-chat`, so `git pull` keeps it up to date) and a **DeepSeek Chat** app in `~/Applications`, which you can open from Spotlight, Launchpad or the Dock. Then open **DeepSeek Chat**, or run `deepseek-chat` in a new Terminal window. Paste your API key in **Settings**; it's stored in the macOS Keychain. Running the setup again is safe.

**Getting updates:**

```bash
deepseek-chat stop
git pull
npm ci
deepseek-chat
```

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

## Your API key

On Windows, paste it in **Settings** (it's stored encrypted with your Windows login). On the Mac, the key lives in the macOS Keychain, never in a file and never in the browser. Set it either way:

- In the app: **Settings → DeepSeek API key → Save key** (it's tested against DeepSeek right away), or
- In Terminal: `security add-generic-password -U -a "$USER" -s deepseek-api-key -w` (it asks you to paste the key)

The `deepseek` terminal command (Claude Code running on DeepSeek) uses the same Keychain entry.

## What you can do

| | |
|---|---|
| **Attach files** | Drag them anywhere onto the window, paste them, or use **+ → Upload files**. Text, code, images (V4.1 Flash can see them), PDFs and Word docs. |
| **Attach a folder** | Drag a folder in, or **+ → Add a folder…** to get a checklist of its files. `node_modules`, `.git`, builds and binaries are skipped automatically, and `.env` files are always blocked. |
| **Let DeepSeek explore a project** | **+ → Add a folder… → Let DeepSeek explore it.** DeepSeek then lists, reads and searches the files it needs by itself (read-only), just like Claude Code. |
| **@-mention a file** | With a project folder open, type `@` and pick a file to attach it. |
| **Thinking** | The **Think** button turns step-by-step reasoning on or off; the model menu sets the effort (High / Max). |
| **Web search** | Off by default. Turn it on in **Settings → Web search** and add a free [Tavily](https://app.tavily.com) key (1,000 searches a month). A **Search** button then appears next to Think; when it's on, DeepSeek can search the web, read pages and cite sources. |
| **Ask / Plan / Edit / Auto** | With a folder open: **Ask** reads and answers. **Plan** writes a step-by-step plan without changing anything. **Edit** changes files, with a before/after preview and Approve/Reject for every change. **Auto** makes all the changes without asking. Every reply's changes can be undone. |
| **Docs folder** | DeepSeek can create and update documents there in any mode (it asks first, or not, per doc). Settings sets the default; projects can set their own. |
| **Terminal** | Per project, off by default. DeepSeek runs commands in the project's folders: look-only ones straight away, others after you click **Run** (or without asking in Auto mode on the Mac). On the Mac they run in a sandbox (only the project folders are writable; keys, logins and the Keychain are unreadable; internet off unless you allow it). On Windows there's no sandbox, so every command but look-only ones asks. Code blocks get a free **▶ Run** button, and the **Running** list shows and stops everything still running. GitHub stays read-only. |
| **Save a reply** | **Save** under any reply writes it to a file you pick in the Mac's Save dialog. |
| **GitHub (read-only)** | Fine-grained token, repos you tick in Settings, repos picked per project, and a GitHub button per chat (off by default). Reads code, issues, PRs, commits and CI; can't change anything. |
| **Projects** | Group chats in the sidebar. Each project has shared context, shared files, **folders linked to every chat in it**, and a memory setting (*Project + global* or *This project only*). Chats can switch off a project folder or add their own. |
| **Several folders** | Link as many folders as you like to a chat or project. DeepSeek sees each by name (`backend/src/app.py`, `web/src/App.tsx`) and can search, read and edit across all of them. |
| **Models** | **V4.1 Flash** (fast, cheap, sees images) or **V4 Pro** (smartest, text only). |
| **Token meter** | The ring next to the model picker shows how full the conversation is, what it's cost so far, and what the next message will cost. |
| **Stop, edit, retry** | Stop a reply with the ■ button or **Esc**. Hover your message to edit and resend it. **Retry** regenerates the last reply. |
| **Send while it's replying** | Messages you send while DeepSeek is working go in at its next step, so it takes them into account in the same reply. **Answer together now** cuts off what it's writing and starts again with your message. Stop puts waiting messages back in the message box. |
| **Several chats at once** | Up to 4 chats can reply at the same time. The sidebar marks chats that are replying (blue) or waiting for your approval (amber), and warns you when two chats are editing the same folder. |
| **Saved chats** | Everything is saved automatically. Search, rename, export to Markdown or delete from the sidebar. |

Long pasted text (more than 4,000 characters) turns into an attachment, like in Claude.

### Keyboard shortcuts

| Action | Keys |
|---|---|
| Send / new line | Enter / Shift + Enter |
| New chat | ⌘ ⇧ O |
| Search chats | ⌘ K |
| Toggle sidebar | ⌘ B |
| Stop reply | Esc |

## Where things are stored

Everything is in `data/` (ignored by Git): one JSON file per chat in `data/chats/`, images in `data/uploads/`, settings in `data/settings.json`, and server logs in `data/server.log`.

## Safety

- The server only listens on `127.0.0.1` and rejects requests from other websites, so nothing else can use it to read your files. Don't deploy it publicly.
- In Ask and Plan mode, DeepSeek's folder access is **read-only**. In Edit mode, every change needs your approval; in Auto mode changes apply straight away. Either way, each reply's changes can be undone. Either way, it can't leave the folder you chose, including through symlinks, and it never touches `.git`, `node_modules` or secret files.
- `.env`, private keys and similar secret files are never read or attached.
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
| `app/api/chat/route.ts` | Sends the conversation to DeepSeek, runs the folder tools, streams the reply, saves it |
| `lib/conversation.ts` | Turns a saved chat into DeepSeek's message format |
| `lib/tools.ts`, `lib/files.ts` | Read-only folder tools and file access |
| `lib/folders.ts`, `lib/roots.ts` | Which folders a chat can use (project + chat, minus switched-off) and how `name/path` maps to disk |
| `lib/websearch.ts` | Web search tools (Tavily) |
| `lib/github.ts` | Read-only GitHub tools (GET requests only, checked against your allowlist) |
| `lib/docs.ts` | Docs folder tools |
| `lib/edits.ts`, `lib/approvals.ts` | Edit mode: file-change tools, previews, backups, undo, approvals |
| `lib/commands.ts` | Terminal rules: look-only, ask, always ask, never run |
| `lib/sandbox.ts`, `lib/processes.ts`, `lib/terminal.ts` | Running commands: the macOS sandbox profile, the Running list, DeepSeek's command tools |
| `lib/secrets.ts` | API keys in the macOS Keychain |
| `lib/skip.ts` | Skip rules for junk folders, binaries and secrets |
| `lib/tokens.ts` | Prices and token estimates (update here if DeepSeek changes prices) |
| `lib/types.ts` | Model list (update here if DeepSeek adds or renames models) |
| `components/` | The interface |
