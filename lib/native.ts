// The computer's own dialogs: choose a folder, "Save As", and "Open".
// macOS uses AppleScript; Windows uses PowerShell's built-in dialogs (nothing to install).
import "server-only";
import { execFile } from "node:child_process";

export interface DialogResult {
  path?: string;
  cancelled?: boolean;
  error?: string;
}

export const hasNativeDialogs = process.platform === "darwin" || process.platform === "win32";
export const UNSUPPORTED = "File dialogs are only available on macOS and Windows. Type the path instead.";

const TIMEOUT = 10 * 60 * 1000; // the dialog waits for you

// ---------- macOS ----------

function appleScript(lines: string[]): Promise<DialogResult> {
  return new Promise((resolve) => {
    execFile("osascript", lines.flatMap((l) => ["-e", l]), { timeout: TIMEOUT }, (err, stdout, stderr) => {
      if (err) {
        // -128 means the person clicked Cancel.
        if (/-128/.test(stderr) || /User canceled/i.test(stderr)) return resolve({ cancelled: true });
        return resolve({ error: stderr.trim() || err.message });
      }
      resolve({ path: stdout.trim() });
    });
  });
}

const esc = (s: string) => s.replace(/[\\"]/g, "\\$&");

// ---------- Windows ----------

// Runs a PowerShell dialog script. Values go in through environment variables, never
// pasted into the script, so names with quotes or odd characters can't break it.
function powerShell(body: string, env: Record<string, string> = {}): Promise<DialogResult> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "Add-Type -AssemblyName System.Windows.Forms",
    // An invisible topmost owner window makes the dialog open in front of the browser.
    "$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }",
    body,
  ].join("\n");
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: TIMEOUT, env: { ...process.env, ...env }, windowsHide: true },
      (err, stdout, stderr) => {
        if (err && (err as { code?: number }).code === 2) return resolve({ cancelled: true }); // our "Cancel" exit code
        if (err) return resolve({ error: stderr.trim() || err.message });
        const p = stdout.trim();
        resolve(p ? { path: p } : { cancelled: true });
      },
    );
  });
}

const winShow = (dialog: string, result: string) =>
  `if (${dialog}.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write(${result}) } else { exit 2 }`;

// ---------- Public ----------

export function chooseFolder(prompt: string): Promise<DialogResult> {
  if (process.platform === "darwin") {
    // `activate` brings the dialog to the front without needing extra macOS permissions.
    return appleScript(["activate", `POSIX path of (choose folder with prompt "${esc(prompt)}")`]).then((r) =>
      r.path ? { path: r.path.replace(/\/$/, "") || "/" } : r,
    );
  }
  if (process.platform === "win32") {
    return powerShell(
      [
        "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
        "$d.Description = $env:DS_PROMPT",
        "$d.ShowNewFolderButton = $true",
        winShow("$d", "$d.SelectedPath"),
      ].join("\n"),
      { DS_PROMPT: prompt },
    );
  }
  return Promise.resolve({ error: UNSUPPORTED });
}

export function chooseSaveFile(prompt: string, defaultName: string): Promise<DialogResult> {
  if (process.platform === "darwin") {
    return appleScript([
      "activate",
      `set f to choose file name with prompt "${esc(prompt)}" default name "${esc(defaultName)}" default location (path to documents folder)`,
      "POSIX path of f",
    ]);
  }
  if (process.platform === "win32") {
    return powerShell(
      [
        "$d = New-Object System.Windows.Forms.SaveFileDialog",
        "$d.Title = $env:DS_PROMPT",
        "$d.FileName = $env:DS_NAME",
        "$d.Filter = 'Markdown (*.md)|*.md|Text (*.txt)|*.txt|All files (*.*)|*.*'",
        "$d.InitialDirectory = [Environment]::GetFolderPath('MyDocuments')",
        "$d.OverwritePrompt = $true",
        winShow("$d", "$d.FileName"),
      ].join("\n"),
      { DS_PROMPT: prompt, DS_NAME: defaultName },
    );
  }
  return Promise.resolve({ error: UNSUPPORTED });
}

export function chooseExistingFile(prompt: string): Promise<DialogResult> {
  if (process.platform === "darwin") {
    return appleScript(["activate", `set f to choose file with prompt "${esc(prompt)}" default location (path to documents folder)`, "POSIX path of f"]);
  }
  if (process.platform === "win32") {
    return powerShell(
      [
        "$d = New-Object System.Windows.Forms.OpenFileDialog",
        "$d.Title = $env:DS_PROMPT",
        "$d.Filter = 'Text files (*.md;*.txt;*.markdown)|*.md;*.txt;*.markdown|All files (*.*)|*.*'",
        "$d.InitialDirectory = [Environment]::GetFolderPath('MyDocuments')",
        winShow("$d", "$d.FileName"),
      ].join("\n"),
      { DS_PROMPT: prompt },
    );
  }
  return Promise.resolve({ error: UNSUPPORTED });
}
