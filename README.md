# DeepSeek Chat

A personal, Claude-desktop-style chat app for the DeepSeek API. It runs only on your Mac.

**Quick reference for every command: [CHEATSHEET.md](CHEATSHEET.md)**

## Open it

- **Spotlight / Dock:** open **DeepSeek Chat** (in `~/Applications`), or
- **Terminal:** run `deepseek-chat`

The first launch builds the app (about 30 seconds). After that it opens instantly in its own Chrome window.
Closing the window leaves a small background server running so the app reopens instantly.
Other commands: `deepseek-chat status`, `deepseek-chat stop`, `deepseek-chat restart`, `deepseek-chat logs`.

### On Windows

From the app folder in PowerShell: `npm install`, then `powershell -ExecutionPolicy Bypass -File scripts\windows\install.ps1`. That adds a **DeepSeek Chat** shortcut (Desktop and Start menu) and the `deepseek-chat` command, with the same subcommands as on the Mac. Keys are stored encrypted with your Windows login, and the folder and save dialogs are Windows' own.

## Your API key

The key lives in the macOS Keychain, never in a file and never in the browser. Set it either way:

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
| **Save a reply** | **Save** under any reply writes it to a file you pick in the Mac's Save dialog. |
| **GitHub (read-only)** | Fine-grained token, repos you tick in Settings, repos picked per project, and a GitHub button per chat (off by default). Reads code, issues, PRs, commits and CI; can't change anything. |
| **Projects** | Group chats in the sidebar. Each project has shared context, shared files, **folders linked to every chat in it**, and a memory setting (*Project + global* or *This project only*). Chats can switch off a project folder or add their own. |
| **Several folders** | Link as many folders as you like to a chat or project. DeepSeek sees each by name (`backend/src/app.py`, `web/src/App.tsx`) and can search, read and edit across all of them. |
| **Models** | **V4.1 Flash** (fast, cheap, sees images) or **V4 Pro** (smartest, text only). |
| **Token meter** | The ring next to the model picker shows how full the conversation is, what it's cost so far, and what the next message will cost. |
| **Stop, edit, retry** | Stop a reply with the ■ button or **Esc**. Hover your message to edit and resend it. **Retry** regenerates the last reply. |
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
- The app can't run Terminal commands. For that, use the `deepseek` command in a terminal (Claude Code running on DeepSeek).

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
| `lib/secrets.ts` | API keys in the macOS Keychain |
| `lib/skip.ts` | Skip rules for junk folders, binaries and secrets |
| `lib/tokens.ts` | Prices and token estimates (update here if DeepSeek changes prices) |
| `lib/types.ts` | Model list (update here if DeepSeek adds or renames models) |
| `components/` | The interface |
