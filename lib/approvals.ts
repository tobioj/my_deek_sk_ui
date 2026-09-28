// Edit approvals: the chat route waits here until you click Approve or Reject.
// Kept on globalThis because each API route is bundled separately but runs in the same process.
import "server-only";

export type Decision = "approve" | "reject" | "approve_remember"; // approve_remember: a doc save, plus "don't ask again"

interface Pending {
  chatId: string;
  resolve: (d: Decision) => void;
}

const g = globalThis as unknown as { __editApprovals?: Map<string, Pending> };
const pending = (g.__editApprovals ??= new Map<string, Pending>());

export function waitForApproval(chatId: string, callId: string, signal: AbortSignal): Promise<Decision> {
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
      resolve: (d) => {
        signal.removeEventListener("abort", onAbort);
        pending.delete(key);
        resolve(d);
      },
    });
  });
}

export function decide(chatId: string, callId: string, decision: Decision): boolean {
  const p = pending.get(`${chatId}:${callId}`);
  if (!p) return false;
  p.resolve(decision);
  return true;
}

export function decideAll(chatId: string, decision: Decision): number {
  let n = 0;
  for (const p of [...pending.values()]) {
    if (p.chatId === chatId) {
      p.resolve(decision);
      n++;
    }
  }
  return n;
}
