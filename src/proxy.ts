import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
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
  const path = request.nextUrl.pathname;
  if (PUBLIC_ADMIN.has(path)) {
    // A signed-in admin skips the login form: the session cookies last 400 days.
    if (path === "/admin/login" && userData.user && (await isFullAdmin(supabase))) {
      const redirect = NextResponse.redirect(new URL("/admin", request.url));
      response.cookies.getAll().forEach((c) => redirect.cookies.set(c));
      return redirect;
    }
    response.headers.set("x-robots-tag", "noindex, nofollow");
    return response;
  }
  if (!userData.user) return notFound();
  if (!(await isFullAdmin(supabase))) return notFound();

  response.headers.set("x-robots-tag", "noindex, nofollow");
  response.headers.set("cache-control", "private, no-store");
  return response;
}

/** True when the session has passed TOTP (aal2) and the user is an admin. */
async function isFullAdmin(supabase: SupabaseClient) {
  const { data: claims } = await supabase.auth.getClaims();
  if (claims?.claims.aal !== "aal2") return false;
  const { data: isAdmin } = await supabase.rpc("is_admin");
  return isAdmin === true;
}

export const config = {
  matcher: ["/admin", "/admin/:path*", "/api/admin/:path*"],
};
