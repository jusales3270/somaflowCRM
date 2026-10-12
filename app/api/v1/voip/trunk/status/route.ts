/**
 * GET /api/v1/voip/trunk/status — o tronco SIP da organização ativa está
 * conectado? (manager+)
 *
 * Responde com UM estado (`estadoDoTronco`, em `lib/voip/tronco-da-organizacao.ts`)
 * e os sinais que o produziram: a tela diz "Conectado", "O provedor recusou o
 * usuário ou a senha", "O provedor não responde"… em vez de a ligação falhar em
 * silêncio. Só leitura; nada de segredo na resposta.
 */
import { randomUUID } from "node:crypto";

import { ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { estadoDoTronco, sinaisDoTronco } from "@/lib/voip/tronco-da-organizacao";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "voip_trunk_settings" });
  if (!authz.ok) return authz.response;

  const sinais = await sinaisDoTronco(createAdminClient(), authz.org.orgId);
  return ok(
    { estado: estadoDoTronco(sinais), sinais, verificado_em: new Date().toISOString() },
    { requestId },
  );
}
