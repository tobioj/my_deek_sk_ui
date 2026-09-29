// Approvals for file changes and commands: the chat route waits here until you click.
// Kept on globalThis because each API route is bundled separately but runs in the same process.
import "server-only";

// approve_remember: a doc save plus "don't ask again", or a command plus "Always allow".
export type Decision = "approve" | "reject" | "approve_remember";

interface Pending {
  chatId: string;
  kind: "edit" | "command";
  resolve: (d: Decision) => void;
}

const g = globalThis as unknown as { __editApprovals?: Map<string, Pending>; __editedCommands?: Map<string, string> };
const pending = (g.__editApprovals ??= new Map<string, Pending>());
const edited = (g.__editedCommands ??= new Map<string, string>()); // commands you changed before running them

export function waitForApproval(chatId: string, callId: string, signal: AbortSignal, kind: Pending["kind"] = "edit"): Promise<Decision> {
  const key = `${chatId}:${callId}`;
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      pending.delete(key);
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    pending.set(key, {
      chatId,
      kind,
      resolve: (d) => {
        signal.removeEventListener("abort", onAbort);
        pending.delete(key);
        resolve(d);
      },
    });
  });
}

export function decide(chatId: string, callId: string, decision: Decision, command?: string): boolean {
  const key = `${chatId}:${callId}`;
  const p = pending.get(key);
  if (!p) return false;
  if (p.kind === "command" && typeof command === "string" && command.trim()) edited.set(key, command.trim());
  p.resolve(decision);
  return true;
}

// The command as you edited it on the card, if you did.
export function takeEditedCommand(chatId: string, callId: string): string | undefined {
  const key = `${chatId}:${callId}`;
  const c = edited.get(key);
  edited.delete(key);
  return c;
}

// "Switch to Auto" approves waiting file changes. Commands always need their own click.
export function decideAll(chatId: string, decision: Decision): number {
  let n = 0;
  for (const p of [...pending.values()]) {
    if (p.chatId === chatId && p.kind === "edit") {
      p.resolve(decision);
      n++;
    }
  }
  return n;
}
