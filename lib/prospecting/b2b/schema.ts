/**
 * Contratos da prospecção B2B (busca de empresas por CNPJ).
 *
 * Os filtros chegam do navegador e de token de API: tudo é validado aqui, e o
 * código de CNAE e de município é conferido de novo contra o catálogo oficial no
 * servidor (`./catalogos.ts`) — o formato certo não basta, o código tem de existir.
 */
import { z } from "zod";

/** Porte da Receita: 1 = ME, 3 = EPP, 5 = Demais (faturamento acima de R$ 4,8 mi/ano). */
export const PORTES = { ME: 1, EPP: 3, DEMAIS: 5 } as const;
export const PORTE_PADRAO = [PORTES.DEMAIS];

/** Teto por busca: cada 10 empresas custam 1 crédito na CNPJá. */
export const MAXIMO_POR_BUSCA = 1000;

/** Teto de gasto de UMA busca de decisores no Treg (US$). */
export const MAXIMO_DE_GASTO_USD = 200;

export const filtrosB2bSchema = z
  .object({
    /** O que a pessoa descreveu — guardado para a qualificação (perfil ideal). */
    descricao: z.string().trim().max(500).default(""),
    cnaes: z.array(z.string().regex(/^\d{7}$/)).min(1).max(50),
    /** `principal`: só a atividade principal; `qualquer`: principal ou secundária. */
    tipo_cnae: z.enum(["principal", "qualquer"]).default("principal"),
    ufs: z.array(z.string().regex(/^[A-Z]{2}$/)).max(27).default([]),
    municipios: z.array(z.number().int().min(1000000).max(9999999)).max(200).default([]),
    portes: z
      .array(z.union([z.literal(1), z.literal(3), z.literal(5)]))
      .min(1)
      .default(PORTE_PADRAO),
    so_ativas: z.boolean().default(true),
    so_matriz: z.boolean().default(true),
    nao_optante_simples: z.boolean().default(false),
    capital_minimo: z.number().int().min(0).max(100_000_000_000).nullable().default(null),
    exige_telefone: z.boolean().default(false),
    exige_email: z.boolean().default(false),
    max_resultados: z.number().int().min(10).max(MAXIMO_POR_BUSCA).default(100),
  })
  .strict()
  .refine((f) => f.ufs.length > 0 || f.municipios.length > 0, {
    message: "Escolha ao menos um estado ou uma cidade.",
    path: ["ufs"],
  });

export type FiltrosB2b = z.infer<typeof filtrosB2bSchema>;

const credencial = z.string().trim().min(8).max(500);

export const b2bInputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("configure_credential"),
    provider: z.enum(["cnpja", "treg"]),
    api_key: credencial,
  }),
  z.object({ action: z.literal("test_credential"), provider: z.enum(["cnpja", "treg"]) }),
  z.object({ action: z.literal("suggest_cnae"), descricao: z.string().trim().min(3).max(500) }),
  z.object({
    action: z.literal("search"),
    request_id: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    filtros: filtrosB2bSchema,
  }),
  z.object({ action: z.literal("load_more"), id: z.string().uuid() }),
  z.object({
    action: z.literal("select"),
    id: z.string().uuid(),
    selected: z.boolean(),
    company_ids: z.array(z.string().uuid()).min(1).max(1000),
  }),
  /** R$ por crédito da CNPJá (o plano de quem assina); `null` volta ao padrão. */
  z.object({
    action: z.literal("set_price"),
    provider: z.literal("cnpja"),
    preco_unidade_brl: z.number().min(0).max(10).nullable(),
  }),
  /** Nota de aderência pelo Jev para as empresas ainda sem nota da busca. */
  z.object({ action: z.literal("qualify"), id: z.string().uuid() }),
  /** Decisores pelo Treg, nas empresas MARCADAS da busca, com teto de gasto. */
  z.object({
    action: z.literal("enrich_start"),
    request_id: z.string().uuid(),
    search_id: z.string().uuid(),
    cargos: z.array(z.string().trim().min(2).max(60)).min(1).max(5),
    por_empresa: z.number().int().min(1).max(3).default(1),
    com_celular: z.boolean().default(false),
    teto_usd: z.number().min(0.1).max(MAXIMO_DE_GASTO_USD),
  }),
  z.object({ action: z.literal("enrich_step"), run_id: z.string().uuid() }),
  z.object({ action: z.literal("enrich_cancel"), run_id: z.string().uuid() }),
  /** Remove o decisor e não o busca de novo (supressão). */
  z.object({ action: z.literal("contact_remove"), contact_id: z.string().uuid() }),
]);

export type B2bInput = z.infer<typeof b2bInputSchema>;

/** Uma empresa já normalizada, pronta para gravar e mostrar. */
export interface EmpresaB2b {
  cnpj: string;
  razao_social: string;
  nome_fantasia: string | null;
  cnae_principal: string | null;
  cnae_principal_descricao: string | null;
  cnaes_secundarios: string[];
  porte_id: number | null;
  porte: string | null;
  capital_social: number | null;
  simples_optante: boolean | null;
  natureza_juridica: string | null;
  uf: string | null;
  municipio_ibge: number | null;
  cidade: string | null;
  aberta_em: string | null;
  situacao: string | null;
  telefones: Array<{ numero: string; tipo: "fixo" | "celular" }>;
  emails: string[];
  dominio: string | null;
}
