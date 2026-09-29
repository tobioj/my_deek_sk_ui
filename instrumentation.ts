// Runs once when the server starts: stops any commands a crash left running (see lib/processes.ts).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initProcesses } = await import("./lib/processes");
    await initProcesses();
  }
}
