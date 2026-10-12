/**
 * O TRONCO DA ORGANIZAÇÃO, DO BANCO AO ASTERISK — e o estado dele de volta.
 *
 * O banco (`voip_trunk_settings`) é a fonte; o Asterisk é o reflexo. Quem
 * aplica: o PUT de `/api/v1/voip/trunk` (na hora em que se salva) e o cron
 * `voip-tronco` (que recria o que sumiu — contêiner recriado, volume perdido).
 * Quem lê o estado: `GET /api/v1/voip/trunk/status`, para a tela.
 */
import { byteaToBuffer, decryptKey } from "@/lib/crypto/aes_gcm";
import type { createAdminClient } from "@/lib/supabase/admin";

import { configDaAmiDoAmbiente, lerRegistros } from "./ami";
import {
  aplicarTronco,
  asteriskAlcancavel,
  configDaAriDoAmbiente,
  estadoDoEndpoint,
  nomesDoTronco,
  removerTronco,
  troncoPresente,
  type DadosDoTronco,
  type ResultadoNoAsterisk,
} from "./tronco-no-asterisk";

type Admin = ReturnType<typeof createAdminClient>;

interface LinhaDoTronco {
  organization_id: string;
  host: string;
  port: number;
  username: string;
  from_domain: string | null;
  is_active: boolean;
  password_encrypted: unknown;
  password_iv: unknown;
  password_tag: unknown;
}

const COLUNAS =
  "organization_id, host, port, username, from_domain, is_active, password_encrypted, password_iv, password_tag";

/** Lê a linha com a senha decifrada. `null` = a organização não tem tronco. */
export async function lerTronco(
  admin: Admin,
  orgId: string,
  senhaEmClaro?: string,
): Promise<{ dados: DadosDoTronco; ativo: boolean } | null> {
  const { data, error } = await admin
    .from("voip_trunk_settings")
    .select(COLUNAS)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) throw new Error(`voip_trunk_leitura_falhou: ${error.message}`);
  if (!data) return null;
  const linha = data as unknown as LinhaDoTronco;
  const senha =
    senhaEmClaro ??
    decryptKey({
      ciphertext: byteaToBuffer(linha.password_encrypted),
      iv: byteaToBuffer(linha.password_iv),
      tag: byteaToBuffer(linha.password_tag),
    });
  return {
    ativo: linha.is_active,
    dados: {
      orgId,
      host: linha.host,
      port: linha.port,
      username: linha.username,
      password: senha,
      fromDomain: linha.from_domain,
    },
  };
}

/**
 * Leva ao Asterisk o que está no banco: ativo → aplica; desativado → remove.
 * Sem telefonia na instalação devolve `sem_telefonia` — o tronco continua
 * guardado e entra no Asterisk quando ela for ligada (o cron reconcilia).
 */
export async function sincronizarTronco(
  admin: Admin,
  orgId: string,
  senhaEmClaro?: string,
): Promise<ResultadoNoAsterisk> {
  const cfg = configDaAriDoAmbiente();
  if (!cfg) return { ok: false, motivo: "sem_telefonia" };
  const tronco = await lerTronco(admin, orgId, senhaEmClaro);
  if (!tronco) return removerTronco(orgId, cfg);
  return tronco.ativo ? aplicarTronco(tronco.dados, cfg) : removerTronco(orgId, cfg);
}

// ─────────────────────────────────────────────────────────────────────────────
// Estado, para a tela
// ─────────────────────────────────────────────────────────────────────────────

export type EstadoDoTronco =
  | "nao_cadastrado"
  | "sem_telefonia"
  | "asterisk_fora"
  | "desativado"
  | "nao_aplicado"
  | "conectado"
  | "recusado"
  | "conectando"
  | "sem_resposta"
  | "provedor_responde";

export interface SinaisDoTronco {
  cadastrado: boolean;
  ativo: boolean;
  telefonia: boolean;
  alcancavel: boolean;
  presente: boolean;
  /** Status do registro pela AMI (`Registered`, `Rejected`…); `null` = AMI indisponível. */
  registro: string | null;
  /** Estado do endpoint pela ARI (`online`, `offline`, `unknown`). */
  endpoint: string | null;
}

/** Um estado só, na ordem em que a pessoa precisa resolver as coisas. Puro. */
export function estadoDoTronco(s: SinaisDoTronco): EstadoDoTronco {
  if (!s.cadastrado) return "nao_cadastrado";
  if (!s.telefonia) return "sem_telefonia";
  if (!s.alcancavel) return "asterisk_fora";
  if (!s.ativo) return "desativado";
  if (!s.presente) return "nao_aplicado";
  if (s.registro === "Registered") return "conectado";
  if (s.registro === "Rejected") return "recusado";
  // Sem AMI (Asterisk de antes do `iniciar.sh`): só dá para dizer se o
  // provedor responde, não se aceitou o login.
  if (s.registro === null) return s.endpoint === "online" ? "provedor_responde" : "sem_resposta";
  return s.endpoint === "online" ? "conectando" : "sem_resposta";
}

export async function sinaisDoTronco(admin: Admin, orgId: string): Promise<SinaisDoTronco> {
  const { data } = await admin
    .from("voip_trunk_settings")
    .select("is_active")
    .eq("organization_id", orgId)
    .maybeSingle();
  const base: SinaisDoTronco = {
    cadastrado: !!data,
    ativo: !!(data as { is_active?: boolean } | null)?.is_active,
    telefonia: false,
    alcancavel: false,
    presente: false,
    registro: null,
    endpoint: null,
  };
  const cfg = configDaAriDoAmbiente();
  if (!base.cadastrado || !cfg) return base;
  base.telefonia = true;
  base.alcancavel = await asteriskAlcancavel(cfg);
  if (!base.alcancavel) return base;
  base.presente = await troncoPresente(orgId, cfg);
  if (!base.presente) return base;
  base.endpoint = await estadoDoEndpoint(orgId, cfg);
  const ami = configDaAmiDoAmbiente();
  if (ami) {
    const lido = await lerRegistros(ami);
    if (lido.ok) base.registro = lido.registros.get(nomesDoTronco(orgId).registration) ?? "Unregistered";
  }
  return base;
}
