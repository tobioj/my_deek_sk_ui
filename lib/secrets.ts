// API keys, kept on the server only. Looked up from .env.local first, then secure storage:
// the macOS Keychain, or on Windows a file encrypted with your Windows login (DPAPI).
// data/settings.json is only a last-resort fallback on other systems.
import "server-only";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { KeyStatus } from "./types";
import { getStoredSecret, SECRETS_DIR, setStoredSecret } from "./storage";

const run = promisify(execFile);
const isMac = process.platform === "darwin";
const isWindows = process.platform === "win32";

// ---------- Windows: DPAPI via PowerShell (only your Windows account can decrypt) ----------

const dpapiFile = (service: string) => path.join(SECRETS_DIR, `${service}.dpapi`);

function powerShell(script: string, env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `$ErrorActionPreference = 'Stop'\n[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n${script}`],
      { timeout: 15_000, env: { ...process.env, ...env }, windowsHide: true },
      (err, stdout, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout.trim())),
    );
  });
}

async function readWindows(service: string): Promise<string | null> {
  try {
    await fs.access(dpapiFile(service));
  } catch {
    return null;
  }
  try {
    return (
      (await powerShell(
        [
          "$enc = (Get-Content -Raw -LiteralPath $env:DS_FILE).Trim()",
          "$s = ConvertTo-SecureString -String $enc",
          "$b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)",
          "try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }",
        ].join("\n"),
        { DS_FILE: dpapiFile(service) },
      )) || null
    );
  } catch {
    return null;
  }
}

async function saveWindows(service: string, value: string): Promise<void> {
  // The key reaches PowerShell through an environment variable, not the command line.
  const encrypted = await powerShell(
    "$s = ConvertTo-SecureString -String $env:DS_SECRET -AsPlainText -Force\n[Console]::Out.Write((ConvertFrom-SecureString -SecureString $s))",
    { DS_SECRET: value },
  );
  if (!encrypted) throw new Error("Windows couldn't encrypt the key");
  await fs.mkdir(SECRETS_DIR, { recursive: true });
  await fs.writeFile(dpapiFile(service), encrypted);
}

export type SecretName = "deepseek" | "anthropic" | "tavily" | "github";

const SECRETS: Record<SecretName, { service: string; env: string; pattern: RegExp; label: string }> = {
  // Same Keychain entry the `deepseek` terminal command uses.
  deepseek: { service: "deepseek-api-key", env: "DEEPSEEK_API_KEY", pattern: /^[A-Za-z0-9_\-.]{10,200}$/, label: "DeepSeek API key" },
  anthropic: { service: "anthropic-api-key", env: "ANTHROPIC_API_KEY", pattern: /^[A-Za-z0-9_\-]{20,300}$/, label: "Claude API key" },
  tavily: { service: "tavily-api-key", env: "TAVILY_API_KEY", pattern: /^[A-Za-z0-9_\-.]{10,200}$/, label: "Tavily API key" },
  github: { service: "github-token", env: "GITHUB_TOKEN", pattern: /^[A-Za-z0-9_]{20,255}$/, label: "GitHub token" },
};

const cache = new Map<SecretName, { key: string | null; source: KeyStatus["source"]; at: number }>();

async function readKeychain(service: string): Promise<string | null> {
  if (!isMac) return null;
  try {
    const { stdout } = await run("security", ["find-generic-password", "-s", service, "-w"], { timeout: 5000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function getSecret(name: SecretName): Promise<{ key: string | null; source: KeyStatus["source"] }> {
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < 30_000) return hit;
  const def = SECRETS[name];
  let result: { key: string | null; source: KeyStatus["source"] } = { key: null, source: null };
  if (process.env[def.env]) result = { key: process.env[def.env]!, source: "env" };
  else {
    const kc = isWindows ? await readWindows(def.service) : await readKeychain(def.service);
    if (kc) result = { key: kc, source: isWindows ? "windows" : "keychain" };
    else {
      const stored = await getStoredSecret(name);
      if (stored && isWindows) {
        // Older versions kept keys in plain text on Windows: encrypt it and remove the plain copy.
        try {
          await saveWindows(def.service, stored);
          await setStoredSecret(name, null);
          result = { key: stored, source: "windows" };
        } catch {
          result = { key: stored, source: "settings" };
        }
      } else if (stored) result = { key: stored, source: "settings" };
    }
  }
  cache.set(name, { ...result, at: Date.now() });
  return result;
}

export async function secretStatus(name: SecretName): Promise<KeyStatus> {
  const { key, source } = await getSecret(name);
  return { configured: !!key, source, hint: key ? key.slice(-4) : null };
}

export function forgetCachedSecret(name: SecretName) {
  cache.delete(name);
}

export async function saveSecret(name: SecretName, value: string): Promise<KeyStatus> {
  const def = SECRETS[name];
  const trimmed = value.trim();
  if (!def.pattern.test(trimmed)) throw new Error(`That doesn't look like a ${def.label}.`);
  if (isMac) {
    // Feed the command through stdin so the key never shows up in the process list.
    await new Promise<void>((resolve, reject) => {
      const child = spawn("security", ["-i"], { stdio: ["pipe", "ignore", "pipe"] });
      let err = "";
      child.stderr.on("data", (d) => (err += d));
      child.on("error", reject);
      child.on("close", (code) => (code === 0 && !err.trim() ? resolve() : reject(new Error(err.trim() || "Keychain save failed"))));
      child.stdin.end(`add-generic-password -U -a "${os.userInfo().username}" -s ${def.service} -w "${trimmed}"\n`);
    });
  } else if (isWindows) {
    await saveWindows(def.service, trimmed);
    await setStoredSecret(name, null); // make sure no plain-text copy is left behind
  } else {
    await setStoredSecret(name, trimmed);
  }
  cache.delete(name);
  return secretStatus(name);
}

export async function removeSecret(name: SecretName): Promise<KeyStatus> {
  if (isWindows) await fs.rm(dpapiFile(SECRETS[name].service), { force: true });
  if (isMac) {
    try {
      await run("security", ["delete-generic-password", "-s", SECRETS[name].service], { timeout: 5000 });
    } catch {}
  }
  await setStoredSecret(name, null);
  cache.delete(name);
  return secretStatus(name);
}
