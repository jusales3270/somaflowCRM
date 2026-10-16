/**
 * As chaves dos provedores da prospecção B2B (CNPJá, Treg), uma por organização e
 * provedor, em `prospecting_provider_credentials` (migration 9002).
 *
 * Cifradas por `fn_encrypt_oauth` (via `lib/webhooks/secrets`), como a chave do
 * Apify em `prospecting_settings` — que NÃO mora aqui: o motor do Google Maps não
 * é tocado. O plaintext só existe na requisição que salva e no instante da chamada
 * ao provedor; a tela vê só os 4 últimos caracteres.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type pg from "pg";

import { decryptWebhookSecret, encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { saldoDaCnpja } from "./cnpja";

export type ProvedorB2b = "cnpja" | "treg";

export class ErroDeCredencial extends Error {
  constructor(
    message: string,
    readonly status = 422,
  ) {
    super(message);
    this.name = "ErroDeCredencial";
  }
}

export interface EstadoDaCredencial {
  provider: ProvedorB2b;
  configurada: boolean;
  last4: string | null;
  verificada_em: string | null;
}

export async function estadoDasCredenciais(
  db: pg.Pool | pg.PoolClient,
  org: string,
): Promise<EstadoDaCredencial[]> {
  const { rows } = await db.query<{ provider: ProvedorB2b; last4: string | null; verified_at: Date | null }>(
    "select provider,last4,verified_at from prospecting_provider_credentials where organization_id=$1",
    [org],
  );
  return (["cnpja", "treg"] as const).map((provider) => {
    const linha = rows.find((r) => r.provider === provider);
    return {
      provider,
      configurada: !!linha,
      last4: linha?.last4 ?? null,
      verificada_em: linha?.verified_at ? linha.verified_at.toISOString() : null,
    };
  });
}

export async function lerCredencial(
  db: pg.Pool | pg.PoolClient,
  admin: SupabaseClient,
  org: string,
  provider: ProvedorB2b,
): Promise<string> {
  const { rows } = await db.query<{ credential_encrypted: Buffer }>(
    "select credential_encrypted from prospecting_provider_credentials where organization_id=$1 and provider=$2",
    [org, provider],
  );
  const cifrada = rows[0]?.credential_encrypted;
  const nome = provider === "cnpja" ? "CNPJá" : "Treg";
  if (!cifrada) throw new ErroDeCredencial(`Configure a chave da ${nome} antes de continuar.`);
  const chave = await decryptWebhookSecret(admin, cifrada.toString("hex"));
  if (!chave) throw new ErroDeCredencial(`Não foi possível abrir a chave da ${nome}. Salve-a de novo.`);
  return chave;
}

/**
 * Confere a chave no provedor sem gastar nada: na CNPJá, o saldo de créditos.
 * Devolve uma frase para a tela ("1.250 créditos disponíveis").
 */
export async function testarChave(provider: ProvedorB2b, chave: string): Promise<{ detalhe: string }> {
  if (provider === "cnpja") {
    const { creditos } = await saldoDaCnpja(chave);
    return { detalhe: `${creditos.toLocaleString("pt-BR")} créditos disponíveis` };
  }
  // Treg: a validação entra junto do cliente da Treg (decisores, fase seguinte).
  return { detalhe: "Chave guardada" };
}

export async function salvarCredencial(
  db: pg.Pool | pg.PoolClient,
  admin: SupabaseClient,
  org: string,
  provider: ProvedorB2b,
  chave: string,
): Promise<{ detalhe: string }> {
  const teste = await testarChave(provider, chave);
  const cifrada = await encryptWebhookSecret(admin, chave);
  if (!cifrada) throw new ErroDeCredencial("A cifra de credenciais da instalação não está disponível.", 500);
  await db.query(
    `insert into prospecting_provider_credentials(organization_id,provider,credential_encrypted,last4,verified_at)
     values ($1,$2,$3::bytea,$4,${provider === "cnpja" ? "now()" : "null"})
     on conflict (organization_id,provider) do update set credential_encrypted=excluded.credential_encrypted,
       last4=excluded.last4,verified_at=excluded.verified_at,updated_at=now()`,
    [org, provider, cifrada, chave.slice(-4)],
  );
  return teste;
}

export async function marcarVerificada(db: pg.Pool | pg.PoolClient, org: string, provider: ProvedorB2b) {
  await db.query(
    "update prospecting_provider_credentials set verified_at=now(),updated_at=now() where organization_id=$1 and provider=$2",
    [org, provider],
  );
}
