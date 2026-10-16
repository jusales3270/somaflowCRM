import { describe, expect, it } from "vitest";

import { centavosDosCreditos, custoDosProvedoresSchema } from "@/lib/prospecting/b2b/custos";
import {
  casaComCargo,
  ehDaEmpresa,
  escolherDecisores,
  hashDeSupressao,
  hashesDaPessoa,
  nivelDeDecisao,
} from "@/lib/prospecting/b2b/decisores";
import { fichaPublica, notaDaResposta, perguntasDoLote, NIVEIS_DE_ADERENCIA } from "@/lib/prospecting/b2b/qualificar";
import type { EmpresaB2b } from "@/lib/prospecting/b2b/schema";
import { acharEmail, buscarPessoas, ErroDoTreg, normalizarPessoa } from "@/lib/prospecting/b2b/treg";

const empresa: EmpresaB2b = {
  cnpj: "12345678000195",
  razao_social: "ACME FUNDICAO LTDA",
  nome_fantasia: "Acme",
  cnae_principal: "2451200",
  cnae_principal_descricao: "Fundição de ferro e aço",
  cnaes_secundarios: ["2539001"],
  porte_id: 5,
  porte: "DEMAIS",
  capital_social: 5_000_000,
  simples_optante: false,
  natureza_juridica: "Sociedade Empresária Limitada",
  uf: "SP",
  municipio_ibge: 3520509,
  cidade: "Indaiatuba",
  aberta_em: "1990-01-01",
  situacao: "Ativa",
  telefones: [{ numero: "1933334444", tipo: "fixo" }],
  emails: ["contato@acme.com.br"],
  dominio: "acme.com.br",
};

describe("Treg — leitura das pessoas (o formato muda de provedor para provedor)", () => {
  it("lê nome, cargo e LinkedIn pelos nomes de campo mais comuns", () => {
    expect(normalizarPessoa({ full_name: "Ana Souza", title: "Diretora Industrial", linkedin_url: "linkedin.com/in/ana" })).toMatchObject({
      nome: "Ana Souza",
      cargo: "Diretora Industrial",
      linkedin_url: "https://linkedin.com/in/ana",
    });
    expect(normalizarPessoa({ first_name: "João", last_name: "Lima", job_title: "CEO" })).toMatchObject({ nome: "João Lima", cargo: "CEO" });
    expect(normalizarPessoa({ name: { first: "Rui", last: "Alves" }, headline: "Sócio" })).toMatchObject({ nome: "Rui Alves", cargo: "Sócio" });
  });
  it("descarta linha sem nome e URL que não é do LinkedIn", () => {
    expect(normalizarPessoa({ title: "CEO" })).toBeNull();
    expect(normalizarPessoa({ full_name: "Ana", profile_url: "https://exemplo.com/ana" })?.linkedin_url ?? null).toBeNull();
  });
});

describe("Treg — o cliente respeita o dinheiro", () => {
  const op = { tetoMicro: 50_000, organizacao: "org-1", idempotencia: "b2b-item-busca-0" };
  const resposta = (status: number, corpo: unknown, custo = 0) =>
    new Response(JSON.stringify(corpo), {
      status,
      headers: { "Content-Type": "application/json", "X-Treg-Cost-Micro": String(custo), "X-Treg-Call-Id": "call_1" },
    });

  it("manda teto, chave de idempotência e a organização; lê custo e call id", async () => {
    let enviado: RequestInit | undefined;
    const r = await buscarPessoas(
      "tok",
      { dominio: "acme.com.br", empresa: "Acme", cidade: null, limite: 20 },
      {
        ...op,
        buscar: (async (_u: unknown, init?: RequestInit) => {
          enviado = init;
          return resposta(200, { output: { people: [{ full_name: "Ana Souza", title: "CEO" }] } }, 20_000);
        }) as typeof fetch,
      },
    );
    const h = enviado!.headers as Record<string, string>;
    expect(h["X-Treg-Route-Max-Cost"]).toBe("0.050000");
    expect(h["Idempotency-Key"]).toBe("b2b-item-busca-0");
    expect(h["X-Treg-Meta"]).toContain("customer=org-1");
    // Sem cargo: o provedor o ignora (medido) — quem filtra cargo é o nosso lado.
    expect(JSON.parse(String(enviado!.body))).toEqual({ company_domain: "acme.com.br", country: "BR", limit: 20 });
    expect(r).toMatchObject({ custoMicro: 20_000, callId: "call_1" });
    expect(r.saida.map((p) => p.nome)).toEqual(["Ana Souza"]);
  });

  it("402 route_max_cost é o teto (nada cobrado); 402 sem isso é saldo", async () => {
    const com = (corpo: unknown) => ({ ...op, buscar: (async () => resposta(402, corpo)) as unknown as typeof fetch });
    await expect(acharEmail("tok", { nome: "Ana", dominio: "acme.com.br", linkedin_url: null }, com({ error: "route_max_cost" }))).rejects.toMatchObject({
      motivo: "teto",
    });
    await expect(
      acharEmail("tok", { nome: "Ana", dominio: "acme.com.br", linkedin_url: null }, com({ error: "insufficient_balance", balance_micro: 0 })),
    ).rejects.toBeInstanceOf(ErroDoTreg);
    await expect(
      acharEmail("tok", { nome: "Ana", dominio: "acme.com.br", linkedin_url: null }, com({ error: "insufficient_balance" })),
    ).rejects.toMatchObject({ motivo: "saldo" });
  });

  it("e-mail: o veredicto da verificação na mesma chamada vale; sem ele, `verified`", async () => {
    const r = await acharEmail("tok", { nome: "Ana", dominio: "acme.com.br", linkedin_url: null }, {
      ...op,
      buscar: (async () =>
        resposta(200, { output: { email: "Ana@Acme.com.br", verified: false }, _treg: { verification: { verdict: "catch_all" } } }, 5_000)) as unknown as typeof fetch,
    });
    expect(r.saida).toEqual({ email: "ana@acme.com.br", veredicto: "catch_all" });
  });
});

describe("supressão (\"não buscar de novo\")", () => {
  it("o hash não depende de caixa, acento ou barra final", () => {
    expect(hashDeSupressao("email", "Ana@Acme.com.br ")).toBe(hashDeSupressao("email", "ana@acme.com.br"));
    expect(hashDeSupressao("pessoa", "123:José Lima")).toBe(hashDeSupressao("pessoa", "123:jose lima"));
    expect(hashDeSupressao("email", "x@y.com")).toMatch(/^[0-9a-f]{64}$/);
  });
  it("a pessoa é reconhecida por nome+CNPJ, e-mail e LinkedIn (com ou sem https/www)", () => {
    const a = hashesDaPessoa({ nome: "Ana", email: "ana@acme.com.br", linkedin_url: "https://www.linkedin.com/in/ana/" }, "123");
    const b = hashesDaPessoa({ nome: "ANA", email: null, linkedin_url: "linkedin.com/in/ana" }, "123");
    expect(a).toHaveLength(3);
    expect(b.every((h) => a.includes(h))).toBe(true);
  });
});

describe("nota de aderência pelo Jev", () => {
  it("o Jev recebe só dado público de empresa — nada de telefone nem e-mail", () => {
    const ficha = JSON.stringify(fichaPublica(empresa));
    expect(ficha).toContain("Fundição de ferro e aço");
    expect(ficha).not.toContain("1933334444");
    expect(ficha).not.toContain("@");
  });
  it("uma pergunta score de 3 níveis por empresa, com o CNPJ no id", () => {
    const p = perguntasDoLote([{ cnpj: empresa.cnpj, data: empresa }]);
    expect(Object.keys(p)).toEqual(["aderencia_12345678000195"]);
    expect(p.aderencia_12345678000195).toMatchObject({ tipo: "score", criterios: NIVEIS_DE_ADERENCIA });
  });
  it("score 0..2 vira nota 0..1 e faixa pela maior probabilidade; fora disso é ilegível", () => {
    // A resposta da API real (16/10/2026): probabilidades por nível, como objeto.
    expect(notaDaResposta({ tipo: "score", score: 1.95, probabilidades: { "0": 0.01, "1": 0.03, "2": 0.96 }, confianca: 0.93 })).toEqual({
      score: 0.975,
      faixa: "alta",
      confianca: 0.93,
    });
    // A faixa é a do nível mais provável, não o arredondamento da nota.
    expect(notaDaResposta({ tipo: "score", score: 1.5, probabilidades: { "0": 0.1, "1": 0.6, "2": 0.3 } })?.faixa).toBe("media");
    expect(notaDaResposta({ tipo: "score", score: 0.2 })?.faixa).toBe("baixa");
    expect(notaDaResposta({ tipo: "score", score: 3 })).toBeNull();
    expect(notaDaResposta({ tipo: "noul", noul: 0.5 })).toBeNull();
    expect(notaDaResposta(null)).toBeNull();
  });
});

describe("custo dos provedores", () => {
  it("créditos da CNPJá em centavos ao preço do crédito", () => {
    expect(centavosDosCreditos(5, 39.99 / 2500)).toBeCloseTo(7.998, 3);
    expect(centavosDosCreditos(5, 0)).toBe(0);
  });
  it("lê o que o banco devolve (numeric pode vir como texto)", () => {
    const lido = custoDosProvedoresSchema.parse({
      provedores: [
        { provider: "treg", chamadas: "8", unidades: "8", custo_usd_micro: "100000", custo_brl_cents: "50.1", sem_cotacao: 0, operacoes: { busca: 4, email: 4 } },
      ],
      total_brl_cents: "50.1",
      cotacao_atual: { data: "2026-10-15", venda: "5.01" },
    });
    expect(lido.provedores[0]).toMatchObject({ chamadas: 8, custo_usd_micro: 100_000 });
    expect(lido.cotacao_atual?.venda).toBe(5.01);
  });
});

describe("quem é decisor, e de qual empresa (linhas reais do Treg, 16/10/2026)", () => {
  // Linha do quickenrich na busca SEM domínio pela Hydro, em Itu: é de outra empresa.
  const deOutraEmpresa = normalizarPessoa({
    first_name: "João",
    last_name: "Augustinho",
    title: "diretor fundador",
    employee_linkedin: "https://www.linkedin.com/in/joao",
    company_url: "lojadasferramentasonline.com.br",
    company_name: "Grupo Feron - Ferramentas Online",
  })!;
  // Linha do leadsforge na busca pelo domínio da Fundituba: da empresa, mas operador.
  const operador = normalizarPessoa({
    firstName: "Matheus",
    lastName: "Silva",
    jobTitle: "Operador de maquina fixa em gereal",
    company: { domain: "fundituba.com.br" },
  })!;
  const diretorIndustrial = normalizarPessoa({
    firstName: "Carla",
    lastName: "Ramos",
    jobTitle: "Diretora Industrial",
    company: { domain: "fundituba.com.br" },
  })!;
  const socio = normalizarPessoa({ full_name: "Pedro Lima", title: "Sócio-administrador", company_name: "Fundituba Indústria Metalúrgica" })!;
  const fundituba = { razao_social: "FUNDITUBA INDUSTRIA METALURGICA LTDA", nome_fantasia: null, dominio: "fundituba.com.br" };
  const hydro = { razao_social: "HYDRO EXTRUSION BRASIL S/A", nome_fantasia: null, dominio: null };

  it("a linha de outra empresa não entra — pelo domínio e pelo nome", () => {
    expect(deOutraEmpresa.empresa_dominio).toBe("lojadasferramentasonline.com.br");
    expect(ehDaEmpresa(deOutraEmpresa, hydro)).toBe(false);
    expect(ehDaEmpresa(deOutraEmpresa, fundituba)).toBe(false);
    expect(ehDaEmpresa(operador, fundituba)).toBe(true);
    expect(ehDaEmpresa(socio, fundituba)).toBe(true);
  });

  it("cargo operacional não decide; diretor e gerente de área decidem; o topo vem antes", () => {
    expect(nivelDeDecisao("Operador de maquina fixa em gereal")).toBe(0);
    expect(nivelDeDecisao("analista de pcp")).toBe(0);
    expect(nivelDeDecisao("Coordenador do PCMSO")).toBe(0);
    expect(nivelDeDecisao("Assistente geral")).toBe(0);
    expect(nivelDeDecisao("Diretor de Arte Pleno")).toBe(0);
    expect(nivelDeDecisao("Gerente de Produção")).toBe(1);
    expect(nivelDeDecisao("Diretora Industrial")).toBe(1);
    expect(nivelDeDecisao("Sócio-administrador")).toBe(2);
    expect(nivelDeDecisao("CEO")).toBe(2);
    expect(casaComCargo("Diretora Industrial", "Diretor Industrial")).toBe(true);
    expect(casaComCargo("Gerente de Produção", "Diretor Industrial")).toBe(false);
  });

  it("escolhe só decisores da empresa, com o cargo pedido na frente", () => {
    const escolhidos = escolherDecisores([operador, deOutraEmpresa, socio, diretorIndustrial], fundituba, ["Diretor Industrial"], 2);
    expect(escolhidos.map((p) => p.nome)).toEqual(["Carla Ramos", "Pedro Lima"]);
    expect(escolherDecisores([operador, deOutraEmpresa], fundituba, ["CEO"], 3)).toEqual([]);
  });
});
