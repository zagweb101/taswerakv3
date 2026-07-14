// ====================================================================
// Taswerak — Lightweight auth config (Edge-safe, no Prisma/bcrypt here)
// Used by middleware for route protection only.
// Type augmentations live in src/types/next-auth.d.ts
// ====================================================================

import type { NextAuthConfig } from "next-auth";

export const authConfig = {
  // JWT session with 7-day absolute timeout + 1-day idle refresh.
  // After 7 days the user MUST re-authenticate regardless of activity.
  // The JWT is refreshed on each request (rolling) but the absolute
  // maxAge caps the total session lifetime.
  session: {
    strategy: "jwt",
    maxAge: 7 * 24 * 60 * 60, // 7 days (absolute timeout)
  },
  pages: {
    signIn: "/login",
  },
  trustHost: true,
  providers: [], // added by src/auth.ts (Node runtime)
  callbacks: {
    jwt: ({ token, user }) => {
      if (user) {
        token.id = user.id;
        token.role = (user as { role: import("@prisma/client").Role }).role;
      }
      return token;
    },
    session: ({ session, token }) => {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.role = token.role as import("@prisma/client").Role;
      }
      return session;
    },
    authorized: ({ auth, request }) => {
      const path = request.nextUrl.pathname;
      const session = auth;

      // Auth pages — redirect logged-in users to their dashboard
      if ((path === "/login" || path === "/signup") && session?.user?.role) {
        const role = session.user.role.toLowerCase();
        return Response.redirect(new URL(`/${role}`, request.nextUrl));
      }

      // Dashboard paths — require auth + correct role
      const dashboards = ["/student", "/instructor", "/admin"] as const;
      const matchingDash = dashboards.find(
        (d) => path.startsWith(d + "/") || path === d
      );

      if (matchingDash) {
        if (!session?.user?.role) {
          return false; // Auth.js will redirect to signIn page
        }
        if (session.user.role.toLowerCase() !== matchingDash.slice(1)) {
          const correct = `/${session.user.role.toLowerCase()}`;
          return Response.redirect(new URL(correct, request.nextUrl));
        }
      }

      return true;
    },
  },
} satisfies NextAuthConfig;
