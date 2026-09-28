// API keys, kept on the server only. Looked up from .env.local first, then the macOS
// Keychain, then data/settings.json (fallback for machines without a Keychain).
import "server-only";
import { execFile, spawn } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import type { KeyStatus } from "./types";
import { getStoredSecret, setStoredSecret } from "./storage";

const run = promisify(execFile);
const isMac = process.platform === "darwin";

export type SecretName = "deepseek" | "tavily" | "github";

const SECRETS: Record<SecretName, { service: string; env: string; pattern: RegExp; label: string }> = {
  // Same Keychain entry the `deepseek` terminal command uses.
  deepseek: { service: "deepseek-api-key", env: "DEEPSEEK_API_KEY", pattern: /^[A-Za-z0-9_\-.]{10,200}$/, label: "DeepSeek API key" },
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
    const kc = await readKeychain(def.service);
    if (kc) result = { key: kc, source: "keychain" };
    else {
      const stored = await getStoredSecret(name);
      if (stored) result = { key: stored, source: "settings" };
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
  } else {
    await setStoredSecret(name, trimmed);
  }
  cache.delete(name);
  return secretStatus(name);
}

export async function removeSecret(name: SecretName): Promise<KeyStatus> {
  if (isMac) {
    try {
      await run("security", ["delete-generic-password", "-s", SECRETS[name].service], { timeout: 5000 });
    } catch {}
  }
  await setStoredSecret(name, null);
  cache.delete(name);
  return secretStatus(name);
}
