import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Paths under /admin that a signed-out owner must reach to sign in.
const PUBLIC_ADMIN = new Set(["/admin/login", "/api/admin/login"]);

function notFound() {
  return new NextResponse("Not Found", {
    status: 404,
    headers: { "content-type": "text/plain", "x-robots-tag": "noindex, nofollow" },
  });
}

/**
 * Admin gate. Refreshes the Supabase session cookies, then checks
 * the user, the aal2 claim, and is_admin(). Anyone else gets a plain 404.
 * API routes check again on their own, so one mistake here does not open them.
 */
export async function proxy(request: NextRequest) {
  try {
    return await gate(request);
  } catch (e) {
    // Fail closed: any error (missing config, Auth outage) looks like a 404.
    console.error("[proxy]", e);
    return notFound();
  }
}

async function gate(request: NextRequest) {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) {
    return notFound();
  }
  let response = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (list) => {
          list.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          list.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  );

  const { data: userData } = await supabase.auth.getUser();
  if (PUBLIC_ADMIN.has(request.nextUrl.pathname)) {
    response.headers.set("x-robots-tag", "noindex, nofollow");
    return response;
  }
  if (!userData.user) return notFound();

  const { data: claims } = await supabase.auth.getClaims();
  if (claims?.claims.aal !== "aal2") return notFound();

  const { data: isAdmin } = await supabase.rpc("is_admin");
  if (isAdmin !== true) return notFound();

  response.headers.set("x-robots-tag", "noindex, nofollow");
  response.headers.set("cache-control", "private, no-store");
  return response;
}

export const config = {
  matcher: ["/admin", "/admin/:path*", "/api/admin/:path*"],
};
