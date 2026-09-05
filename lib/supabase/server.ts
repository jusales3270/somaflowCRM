/**
 * Supabase client para Server Components, Route Handlers e Server Actions.
 *
 * Lê/escreve cookies via next/headers. Sempre use `getUser()` (valida JWT no
 * backend), NUNCA `getSession()` (confia no cookie local sem revalidar).
 */

import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookieSecure } from "@/lib/supabase/cookie-secure";
import { cookies } from "next/headers";
import { env } from "@/lib/env";
import { isDevSupabaseFallbackActive, devSupabaseFetch } from "@/lib/supabase/dev-adapter";

export async function createClient() {
  const cookieStore = await cookies();

  const client = createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // setAll pode ser chamado de Server Component; nesse caso, ignoramos.
          // Refresh de sessão acontece no middleware do Next.
        }
      },
    },
    global: {
      fetch: isDevSupabaseFallbackActive() ? devSupabaseFetch : undefined,
    },
    // D-01.01: cookie name canônico alinhado ao middleware.
    cookieOptions: {
      name: "sb-deskcomm-auth",
      sameSite: "strict",
      httpOnly: true,
      secure: cookieSecure(),
      path: "/",
    },
  });

  if (
    isDevSupabaseFallbackActive() &&
    cookieStore.get("somaflow_dev_session")?.value === "authenticated"
  ) {
    const devUser = {
      id: "00000000-0000-4000-8000-000000000001",
      app_metadata: {},
      user_metadata: { full_name: "Administrador SomaFlow", locale: "pt-BR" },
      aud: "authenticated",
      role: "authenticated",
      email: "admin@somaflow.com",
      created_at: "2026-09-01T00:00:00.000Z",
    };
    const originalGetUser = client.auth.getUser.bind(client.auth);
    client.auth.getUser = async (jwt?: string) => {
      const res = await originalGetUser(jwt);
      if (res.data?.user) return res;
      return {
        data: { user: devUser as any },
        error: null,
      };
    };
    client.auth.getSession = async () => {
      return {
        data: {
          session: {
            access_token: "mock-dev-token",
            token_type: "bearer",
            expires_in: 3600,
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            refresh_token: "mock-refresh-token",
            user: devUser as any,
          },
        },
        error: null,
      };
    };
  }

  return client;
}
