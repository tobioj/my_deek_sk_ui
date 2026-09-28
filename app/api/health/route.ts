// GET /api/health — used by the launcher script to see if the server is up.
export function GET() {
  return Response.json({ ok: true });
}
