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
import { testarTokenDoTreg } from "./treg";

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
  /** R$ por unidade do provedor (o crédito da CNPJá); `null` = o padrão. */
  preco_unidade_brl: number | null;
}

/**
 * O crédito da CNPJá no plano de R$ 39,99 com 2.500 créditos por mês — o padrão
 * quando a organização não informou o seu. No plano grátis o custo real é zero;
 * a tela deixa trocar.
 */
export const PRECO_PADRAO_DO_CREDITO_CNPJA = 39.99 / 2500;

export async function estadoDasCredenciais(
  db: pg.Pool | pg.PoolClient,
  org: string,
): Promise<EstadoDaCredencial[]> {
  const { rows } = await db.query<{
    provider: ProvedorB2b;
    last4: string | null;
    verified_at: Date | null;
    preco_unidade_brl: string | null;
  }>(
    "select provider,last4,verified_at,preco_unidade_brl from prospecting_provider_credentials where organization_id=$1",
    [org],
  );
  return (["cnpja", "treg"] as const).map((provider) => {
    const linha = rows.find((r) => r.provider === provider);
    return {
      provider,
      configurada: !!linha,
      last4: linha?.last4 ?? null,
      verificada_em: linha?.verified_at ? linha.verified_at.toISOString() : null,
      preco_unidade_brl: linha?.preco_unidade_brl == null ? null : Number(linha.preco_unidade_brl),
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
 * Confere a chave no provedor sem gastar nada: na CNPJá, o saldo de créditos
 * ("1.250 créditos disponíveis"); no Treg, uma leitura que só responde a token
 * válido (o saldo do Treg mora no painel dele).
 */
export async function testarChave(provider: ProvedorB2b, chave: string): Promise<{ detalhe: string }> {
  if (provider === "cnpja") {
    const { creditos } = await saldoDaCnpja(chave);
    return { detalhe: `${creditos.toLocaleString("pt-BR")} créditos disponíveis` };
  }
  await testarTokenDoTreg(chave);
  return { detalhe: "Token do Treg válido" };
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
     values ($1,$2,$3::bytea,$4,now())
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

/** O preço da unidade do provedor (R$ por crédito da CNPJá) para o livro de custo. */
export async function precoDaUnidade(db: pg.Pool | pg.PoolClient, org: string, provider: ProvedorB2b): Promise<number> {
  const { rows } = await db.query<{ preco_unidade_brl: string | null }>(
    "select preco_unidade_brl from prospecting_provider_credentials where organization_id=$1 and provider=$2",
    [org, provider],
  );
  const preco = rows[0]?.preco_unidade_brl;
  if (preco != null) return Number(preco);
  return provider === "cnpja" ? PRECO_PADRAO_DO_CREDITO_CNPJA : 0;
}

export async function definirPrecoDaUnidade(
  db: pg.Pool | pg.PoolClient,
  org: string,
  provider: ProvedorB2b,
  preco: number | null,
): Promise<void> {
  const { rowCount } = await db.query(
    "update prospecting_provider_credentials set preco_unidade_brl=$3,updated_at=now() where organization_id=$1 and provider=$2",
    [org, provider, preco],
  );
  if (!rowCount) throw new ErroDeCredencial("Salve a chave antes de informar o preço do crédito.");
}
