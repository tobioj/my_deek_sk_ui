// Only answer API requests made by this app on this machine.
// Blocks other websites (and DNS-rebinding tricks) from reading your files through localhost.
import { NextResponse, type NextRequest } from "next/server";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function proxy(req: NextRequest) {
  const host = req.headers.get("host") ?? "";
  const hostname = host.replace(/:\d+$/, "");
  if (!LOCAL_HOSTS.has(hostname)) return new NextResponse("Forbidden", { status: 403 });
  const origin = req.headers.get("origin");
  if (origin) {
    let originHost = "";
    try {
      originHost = new URL(origin).host;
    } catch {}
    if (originHost !== host) return new NextResponse("Forbidden", { status: 403 });
  }
  if (req.headers.get("sec-fetch-site") === "cross-site") return new NextResponse("Forbidden", { status: 403 });
  return NextResponse.next();
}

export const config = { matcher: "/api/:path*" };
