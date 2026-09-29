# DeepSeek Cheat Sheet

Everything you need, in one place. Type the commands in **Terminal**.

---

## 1. Open and close the app

| I want to… | Do this |
|---|---|
| Open the app | Spotlight (⌘ Space) → **DeepSeek Chat**, or run `deepseek-chat` |
| Close the window | Red button or ⌘ Q. **The server keeps running in the background**, so the app reopens instantly. That's normal and harmless (about 58 MB of memory, no CPU while idle). Commands that are running (like a dev server) keep running too: reopen the app and stop them from the **Running** list. |
| Shut everything down | `deepseek-chat stop` (restarting your Mac also stops it). This also stops every command the app started. |

## 2. Server commands

| Command | What it does |
|---|---|
| `deepseek-chat` | Starts the server if needed, then opens the app window |
| `deepseek-chat start` | Starts the server only, without opening a window |
| `deepseek-chat status` | Shows whether the server is running, and lists any commands still running |
| `deepseek-chat stop` | Stops every running command, then the server |
| `deepseek-chat restart` | Stops, rebuilds if the code changed, and starts again. Use it after code changes or if something acts weird. |
| `deepseek-chat logs` | Shows the server log live (press Ctrl + C to exit) |

The app lives at **http://127.0.0.1:3456** and is only reachable from your Mac.

## 2b. On Windows

One-time setup, from the app folder in PowerShell:

```
npm install
powershell -ExecutionPolicy Bypass -File scripts\windows\install.ps1
```

This adds **DeepSeek Chat** to your Desktop and Start menu, and the `deepseek-chat` command to new terminals. After that, the same commands as on the Mac work: `deepseek-chat`, `deepseek-chat start`, `status`, `stop`, `restart`, `logs`. The app opens in its own Chrome or Edge window.

- **Keys** are saved encrypted with your Windows login (Windows' equivalent of the Keychain). Paste them in **Settings**.
- **Choose folder…** and **Save** use Windows' own dialogs.
- The `security …` Keychain commands in section 3 are Mac-only. On Windows, manage keys in **Settings**.
- **Terminal** works the same, except Windows has no sandbox: look-only commands (`dir`, `git status`…) run straight away, and **every other command asks you first, even in Auto mode**. The Internet switch is greyed out because it can't be enforced. Commands run in PowerShell.

## 3. API keys

Keys are stored in the **macOS Keychain**, never in a file. The easiest way: in the app, open **Settings** (bottom-left) and paste the key.

**DeepSeek key** (required). Get one at platform.deepseek.com → API keys.

| I want to… | Command |
|---|---|
| Add or replace the key | `security add-generic-password -U -a "$USER" -s deepseek-api-key -w` (it asks you to paste it) |
| Check a key is saved | `security find-generic-password -s deepseek-api-key` |
| Remove the key | `security delete-generic-password -s deepseek-api-key` |

**Tavily key** (only for web search). Free at app.tavily.com: 1,000 searches a month, no card.

| I want to… | Command |
|---|---|
| Add or replace the key | `security add-generic-password -U -a "$USER" -s tavily-api-key -w` |
| Remove the key | `security delete-generic-password -s tavily-api-key
security delete-generic-password -s github-token` |

## 4. Using the app

**Models:** pick from the dropdown next to the send button. That's the only way to switch in the app.

| Model | Good for | Cost |
|---|---|---|
| **V4.1 Flash** (default) | Everyday use. Fast, and can see images. | Cheapest |
| **V4 Pro** | Hard problems. Text only. | About 4× Flash |

**Buttons next to the message box**

| Button | What it does |
|---|---|
| **+** | Upload files or images, or **Add a folder…** |
| **Think** | DeepSeek reasons step by step before answering. Better for hard questions, but slower and uses more tokens. Effort (High / Max) is in the model dropdown. |
| **Search** | DeepSeek can search the web and cite sources. Only visible when turned on in **Settings → Web search**. Off by default in each chat. |
| **Token ring** | Hover it to see how full the chat is and what it has cost |
| **■** | Stops the reply (or press Esc) |

**Files and folders**
- **Drag** files, images, PDFs, Word docs, or whole folders anywhere onto the window.
- **+ → Add a folder… → Let DeepSeek explore it:** DeepSeek reads whatever files it needs by itself. **Repeat to link more folders** (e.g. backend and frontend); each shows as a chip, and × removes it.
- **+ → Add a folder… → Attach selected:** pick specific files from a checklist.
- Type **@** to mention a file from the open project folder.
- `.env` files and other secrets are always blocked.

**Messages:** hover your message → **Edit** to change and resend it. **Retry** under a reply gets a new answer. **Save** under a reply saves it to a file you choose (new file, or add to the end of an existing one).

**Docs folder** (Settings → Docs folder; projects can set their own)
- DeepSeek can **create and update documents** there in **any mode**, even Ask and Plan. Just say "save this as a doc".
- Every save shows a preview with **Approve** / **Reject**. Tick **Don't ask again for this doc** to skip the prompt for that doc; undo that in Settings → Docs folder.
- It can't reach anything else through the Docs folder, and in Plan mode your code stays read-only.

**GitHub (read-only)** (Settings → GitHub)
- Make a **fine-grained token** limited to chosen repos with read-only permissions (the steps are in Settings), then paste it in.
- **Tick** the repos DeepSeek may read. Nothing is allowed until you tick it.
- In each **project's settings**, pick which of those repos its chats may read. None picked = no GitHub in that project.
- Turn the **GitHub** button on in a chat when you want it. It's off by default.
- DeepSeek can read code, issues, PRs, commits and CI, and can't change anything on GitHub.

**Terminal** (Project settings → Terminal; off by default)
- DeepSeek can **run commands** (tests, builds, installs, dev servers) in the **project's folders**. Chats outside a project never get it, and folders a chat adds on its own don't count.
- **Code blocks** in replies get a **▶ Run** button: it runs the command right there and shows the output. It costs nothing (DeepSeek isn't involved). **Send to DeepSeek** puts the output in your message if you want help with it.
- On the Mac, commands run in a **sandbox**: they can only change files in the project folders, can't read your SSH keys, logins, Keychain or this app's data, and can't open or control other apps.
- **Internet for commands** is off by default. Turn it on in Project settings for `npm install`, `pip install`, `git pull`.
- **GitHub stays read-only:** `git push` and the `gh` command never run, and git logins are hidden from commands. Push from your own terminal.

| Kind of command | What happens |
|---|---|
| Look-only (`ls`, `cat`, `grep`, `git status/diff/log`…) | Runs straight away, in every mode |
| Most commands (`npm test`, `npm run build`…) | **Asks first** in Ask, Plan and Edit. Runs without asking in **Auto** (Mac). Click **Always allow** on the card to stop asking for that command in this project; remove it in Project settings. |
| Risky (deleting folders, `git reset --hard`, publishing, anything touching `.env`) | Always asks, even in Auto |
| Never (`sudo`, `git push`, `gh`, `curl … \| sh`, running things in the background with `&`) | Refused, even if you approve |

- On the approval card: **Run**, **Don't run**, **Edit** (change the command first) or **Always allow**. What a command changes can't be undone with **Undo**, so keep your project in Git.
- In **Ask** and **Plan** mode, commands can only look: on the Mac even the project folder is read-only to them.
- **Time limit:** 10 minutes per command by default (30 or 60 in Project settings). If a command is stopped, DeepSeek still gets the output so far.
- **Running list:** the **● running** button at the top right shows every command still running, from any chat, with its log, its port (e.g. localhost:3000) and a **Stop** button. Stop ends the command and everything it started, and only says *Stopped* once the system confirms they're gone. Dev servers DeepSeek starts run in the background and show up here.

**Folder modes** (appear next to the model picker once a folder is open)

| Mode | What DeepSeek can do |
|---|---|
| **Ask** (default) | Read and search your project, and answer questions. Changes nothing. |
| **Plan** | Read your project, then write a step-by-step plan. Changes nothing. When you're happy with the plan, switch to **Edit** or **Auto** and say "go ahead". |
| **Edit** | Create, change and delete files. Every change shows a red/green before-and-after preview with **Approve** / **Reject**. The input box turns amber so you know editing is on. |
| **Auto** | Like Edit, but DeepSeek makes **all** the changes without asking. Use it when the plan is settled and you want the whole thing implemented. Every reply can still be undone. |

**"I've mapped out the whole change, just do it":** plan it in **Plan**, then switch to **Auto** and say "go ahead".

In Edit mode:
- **Approve all** approves everything currently waiting. **Switch to Auto** approves them and stops asking in this chat. Click **Edit** to go back to approving each change.
- **Undo changes** under a reply puts every file it touched back the way it was. If you edited one of those files afterwards, it asks before overwriting your edit.
- It never touches `.env`/secret files, `.git`, `node_modules`, or anything outside the folder. Running commands is separate: see **Terminal** above.
- If the folder has uncommitted Git changes, you'll see a warning. Committing first makes DeepSeek's edits easy to review.

**Projects** (the **Projects** section of the sidebar)

| I want to… | Do this |
|---|---|
| Create a project | Sidebar → **Projects** → **+** |
| Start a chat in a project | Hover the project → ✎ icon, or open it and click **+ New chat** |
| Edit context, files, folder, memory | Hover the project → sliders icon, or click the project name at the top of a chat |
| Move a chat into / out of a project | Hover the chat → **⋯** → **Move to project** / **Remove from project** |
| Delete a project | Project settings → **Delete project** (its chats are kept) |

- **Project context:** instructions and background every chat in the project sees.
- **Folders:** your codebase. Linked to **every** chat in the project (old and new). DeepSeek explores them on demand and only reads what it needs, so size doesn't matter. Add several if your project has several repos.
- **Project files:** small documents (specs, notes, a style guide). Their full text goes with every message.
- In a chat, a project folder shows with a stack icon. Click its **eye** icon to switch it off for just that chat, and again to switch it back on. Folders you add in the chat itself are for that chat only.
- **Memory:** *Project + global* also applies your Settings instructions. *This project only* ignores them.

**What DeepSeek sees in each message:** your Settings instructions (unless the project is set to *This project only*), the project's context and files (if the chat is in a project), and **this chat only**. It never sees your other chats.

**Chats:** saved automatically. Hover a chat in the sidebar → **⋯** to rename, export to Markdown, or delete.

**Keyboard shortcuts**

| Action | Keys |
|---|---|
| Send | Enter |
| New line | Shift + Enter |
| New chat | ⌘ ⇧ O |
| Search chats | ⌘ K |
| Show / hide sidebar | ⌘ B |
| Stop reply | Esc |

## 5. The `deepseek` Terminal command (separate tool, optional)

This is **not** the app. It's Claude Code (a text-only coding assistant that runs in Terminal) with DeepSeek plugged in. It can edit files and run commands in any folder you start it in, without the app's sandbox. It uses no Claude models and Anthropic bills nothing.

| I want to… | Do this |
|---|---|
| Start it in a project | `cd ~/Documents/Coding/my-project`, then `deepseek` |
| Switch to V4 Pro inside it | Type `/model opus` (in this tool, "opus" means DeepSeek V4 Pro) |
| Switch back to V4.1 Flash | Type `/model sonnet` |
| Start directly on V4 Pro | `deepseek --model opus` |
| Leave it | Type `/exit` or press Ctrl + C twice |

## 6. If something goes wrong

| Problem | Fix |
|---|---|
| App window is blank or says it can't reach the server | `deepseek-chat restart` |
| "DeepSeek rejected your API key" | Settings → paste the key again → it's tested automatically |
| "Your DeepSeek balance has run out" | Top up at platform.deepseek.com |
| "Can't reach DeepSeek" | Check your internet connection, then press **Retry** |
| Search button missing | Settings → Web search → turn it on → Save |
| Search button does nothing | Settings → Web search → add your Tavily key |
| DeepSeek made a change you don't want | Click **Undo changes** under that reply |
| Ask / Plan / Edit / Auto buttons missing | They only show when a folder is open: **+ → Add a folder…** |
| DeepSeek says it can't edit files | Switch the chat to **Edit** or **Auto**. It's told about the switch in your next message. |
| No ▶ Run buttons, or DeepSeek can't run commands | The chat must be in a project with **Project settings → Terminal** on, and a project folder switched on in the chat |
| `npm install` / `git pull` fails in a command | **Project settings → Terminal → Internet for commands** (Mac) |
| A command says "not permitted" | The sandbox stopped it from going outside the project folders. That's intended. |
| Something keeps running after I closed the window | Reopen the app → **● running** (top right) → **Stop**, or `deepseek-chat stop` |
| App doesn't show in Spotlight | `mdimport ~/Applications/"DeepSeek Chat.app"` |
| Want to see what went wrong | `deepseek-chat logs` |

## 7. Where things live

| What | Where |
|---|---|
| The app's code | `~/Documents/Coding/UI-DeepSeek` |
| Your saved chats | `~/Documents/Coding/UI-DeepSeek/data/chats/` (one file per chat) |
| Projects | `…/data/projects/` (one file per project) |
| Uploaded images | `…/data/uploads/` |
| Docs DeepSeek saves | `~/Documents/DeepSeek Docs` by default (change in Settings or per project) |
| Backups for Undo | `…/data/backups/` |
| Settings | `…/data/settings.json` |
| Server logs | `…/data/server.log` |
| App launcher | `~/Applications/DeepSeek Chat.app` |
| Commands | `~/.local/bin/deepseek-chat` and `~/.local/bin/deepseek` |

**Back up your chats** by copying the `data/` folder.

## 8. For editing the code

| Command (run inside `UI-DeepSeek`) | What it does |
|---|---|
| `npm run dev` | Development version with live reload at http://127.0.0.1:3455 |
| `npm run typecheck` | Checks the code for type errors |
| `npm run lint` | Checks code style |
| `deepseek-chat restart` | Puts your changes into the everyday app |

## 9. Removing everything

```
deepseek-chat stop
rm -rf ~/Applications/"DeepSeek Chat.app" ~/.local/bin/deepseek-chat ~/.local/bin/deepseek
security delete-generic-password -s deepseek-api-key
security delete-generic-password -s tavily-api-key
```
Then delete the `UI-DeepSeek` folder (back up `data/` first if you want your chats).
