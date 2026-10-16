import { describe, expect, it } from "vitest";

import { centavosDosCreditos, custoDosProvedoresSchema } from "@/lib/prospecting/b2b/custos";
import {
  casaComCargo,
  degrausDeLocal,
  escolherCandidatos,
  escolherEmpresaApollo,
  hashDeSupressao,
  hashesDaPessoa,
  nivelDeDecisao,
} from "@/lib/prospecting/b2b/decisores";
import { fichaPublica, notaDaResposta, perguntasDoLote, NIVEIS_DE_ADERENCIA } from "@/lib/prospecting/b2b/qualificar";
import type { EmpresaB2b } from "@/lib/prospecting/b2b/schema";
import {
  acharEmail,
  apolloBuscarPessoas,
  consultaDaApollo,
  ErroDoTreg,
  normalizarPessoaDaApollo,
  veredictoDaApollo,
} from "@/lib/prospecting/b2b/treg";

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

describe("Apollo pelo Treg — o formato real das respostas (16/10/2026)", () => {
  it("a busca manda empresa, local e senioridades na QUERY, em `campo[]=valor`", () => {
    expect(consultaDaApollo({ q_organization_domains_list: ["acme.com.br"], person_locations: ["Itu, Brazil"], per_page: 25, x: null }))
      .toBe("q_organization_domains_list%5B%5D=acme.com.br&person_locations%5B%5D=Itu%2C+Brazil&per_page=25");
  });

  it("o enriquecimento vira decisor: nome, cargo, LinkedIn (https), e-mail com status", () => {
    // Mesmo formato da resposta real de `apollo.people.enrich`, com dados fictícios.
    const d = normalizarPessoaDaApollo({
      person: {
        name: "Ana Souza",
        title: "CEO",
        linkedin_url: "http://www.linkedin.com/in/ana-souza-123",
        email: "Ana@Acme.com.br",
        email_status: "verified",
        city: "Itupeva",
        organization: { primary_domain: "acme.com.br" },
      },
    });
    expect(d).toEqual({
      nome: "Ana Souza",
      cargo: "CEO",
      linkedin_url: "https://www.linkedin.com/in/ana-souza-123",
      email: "ana@acme.com.br",
      veredicto: "valid",
      cidade: "Itupeva",
      empresa_dominio: "acme.com.br",
    });
  });

  it("e-mail travado ou ausente não vira e-mail; status da Apollo → veredicto", () => {
    expect(normalizarPessoaDaApollo({ person: { name: "Rui", email: "email_not_unlocked@domain.com" } })?.email).toBeNull();
    expect(normalizarPessoaDaApollo({ person: { first_name: "Rui", last_name: "Lima" } })?.nome).toBe("Rui Lima");
    expect(normalizarPessoaDaApollo({})).toBeNull();
    expect(veredictoDaApollo("verified")).toBe("valid");
    expect(veredictoDaApollo("guessed")).toBe("unknown");
    expect(veredictoDaApollo("unavailable")).toBeNull();
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
    let url = "";
    let enviado: RequestInit | undefined;
    const r = await apolloBuscarPessoas(
      "tok",
      { dominio: "acme.com.br", local: "Itu, Brazil", porPagina: 25 },
      {
        ...op,
        buscar: (async (u: unknown, init?: RequestInit) => {
          url = String(u);
          enviado = init;
          return resposta(200, { people: [{ id: "p1", first_name: "Ana", title: "CEO", organization: { name: "Acme" } }] }, 0);
        }) as typeof fetch,
      },
    );
    const h = enviado!.headers as Record<string, string>;
    expect(h["X-Treg-Route-Max-Cost"]).toBe("0.050000");
    expect(h["Idempotency-Key"]).toBe("b2b-item-busca-0");
    expect(h["X-Treg-Meta"]).toContain("customer=org-1");
    expect(url).toContain("/call/apollo.people.search?");
    expect(url).toContain("q_organization_domains_list%5B%5D=acme.com.br");
    expect(url).toContain("person_seniorities%5B%5D=c_suite");
    expect(enviado!.body).toBeUndefined();
    expect(r.saida).toEqual([{ id: "p1", primeiro_nome: "Ana", cargo: "CEO", empresa_nome: "Acme" }]);
    expect(r.callId).toBe("call_1");
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

describe("quem é decisor, e de qual empresa (casos reais de Indaiatuba, 16/10/2026)", () => {
  it("empresa sem domínio: escolhe pelo nome — \"Wetzel\" não vira a construtora \"Chiarelli & Wetzel\"", () => {
    const achadas = [
      { id: "c1", nome: "Chiarelli&Wetzel Construtora Ltda", dominio: "chiawet.com.br", linkedin_url: null },
      { id: "w1", nome: "Wetzel S.A", dominio: "wetzel.com.br", linkedin_url: null },
      { id: "s1", nome: "SingleOne Tech", dominio: "wetzelgardens.com", linkedin_url: null },
    ];
    // A primeira palavra própria é "wetzel"; a construtora também a contém, mas a
    // nossa tem "automotiva" — casa mais com a Wetzel S.A.? Não: empate em 1 palavra,
    // e vale a ordem da Apollo. O que NUNCA passa é quem não tem "wetzel".
    const e = escolherEmpresaApollo(achadas, { razao_social: "ALU OEM DO BRASIL LTDA", nome_fantasia: "Wetzel Automotiva" });
    expect(e?.nome).toMatch(/Wetzel/);
    expect(escolherEmpresaApollo(achadas, { razao_social: "FUSIM INDUSTRIA E COMERCIO DE METAIS LTDA", nome_fantasia: null })).toBeNull();
    expect(
      escolherEmpresaApollo(
        [
          { id: "a", nome: "Hydro Energia", dominio: null, linkedin_url: null },
          { id: "b", nome: "Hydro Extrusion Brasil", dominio: "hydro.com", linkedin_url: null },
        ],
        { razao_social: "HYDRO EXTRUSION BRASIL S/A", nome_fantasia: null },
      )?.id,
    ).toBe("b");
  });

  it("cargo operacional não decide; diretor e gerente de área decidem; o topo vem antes", () => {
    expect(nivelDeDecisao("Operador de maquina fixa em gereal")).toBe(0);
    expect(nivelDeDecisao("Sales Supervisor")).toBe(0);
    expect(nivelDeDecisao("Production Leader")).toBe(0);
    expect(nivelDeDecisao("Diretor de Arte Pleno")).toBe(0);
    expect(nivelDeDecisao("Gerente de Produção")).toBe(1);
    expect(nivelDeDecisao("Industrial Manager")).toBe(1);
    expect(nivelDeDecisao("Managing Partner")).toBe(2);
    expect(nivelDeDecisao("HR Business Partner")).toBe(0);
    expect(nivelDeDecisao("CEO")).toBe(2);
    expect(nivelDeDecisao("Sócio-administrador")).toBe(2);
    expect(casaComCargo("Diretora Industrial", "Diretor Industrial")).toBe(true); // o feminino é o mesmo cargo
    expect(casaComCargo("Gerente de Produção", "Diretor Industrial")).toBe(false);
    // Cargo da Apollo em inglês casa com o escolhido em português.
    expect(casaComCargo("Industrial Director", "Diretor Industrial")).toBe(true);
    expect(casaComCargo("Quality Manager", "Gerente de Qualidade")).toBe(true);
    expect(casaComCargo("IT Manager", "Gerente de TI")).toBe(true);
    expect(casaComCargo("Production Manager", "Gerente de Qualidade")).toBe(false);
    expect(casaComCargo("Diretor Industrial e de Operações", "Diretor Industrial")).toBe(true);
  });

  it("dos candidatos da Apollo, revela primeiro o cargo pedido, depois o topo; supervisor fica fora", () => {
    const c = (id: string, cargo: string) => ({ id, primeiro_nome: id, cargo, empresa_nome: "X" });
    const lista = [c("s", "Sales Supervisor"), c("g", "Gerente Comercial"), c("ceo", "CEO"), c("di", "Diretor Industrial")];
    expect(escolherCandidatos(lista, ["Diretor Industrial"], 2).map((x) => x.id)).toEqual(["di", "ceo"]);
    // Sem cargo pedido que case: o topo, depois a área que compra (industrial), depois o resto.
    expect(escolherCandidatos(lista, ["CFO"], 3).map((x) => x.id)).toEqual(["ceo", "di", "g"]);
    expect(escolherCandidatos([c("s", "Sales Supervisor")], ["CEO"], 1)).toEqual([]);
  });

  it("entre gerentes, a área que compra vem antes da de apoio (caso real da Metaperfil)", () => {
    const c = (id: string, cargo: string) => ({ id, primeiro_nome: id, cargo, empresa_nome: "Metaperfil" });
    // A ordem em que a Apollo devolveu os três gerentes da Metaperfil.
    const lista = [c("qual", "Quality Manager"), c("ind", "Industrial Manager"), c("prod", "Production Manager")];
    expect(escolherCandidatos(lista, ["CEO", "Diretor Industrial"], 1).map((x) => x.id)).toEqual(["ind"]);
    expect(escolherCandidatos(lista, ["CEO"], 3).map((x) => x.id)).toEqual(["ind", "prod", "qual"]);
    // Pedir a área de apoio a traz para a frente.
    expect(escolherCandidatos(lista, ["Gerente de Qualidade"], 1).map((x) => x.id)).toEqual(["qual"]);
  });

  it("a busca vai da cidade da empresa para fora", () => {
    expect(degrausDeLocal("Itu")).toEqual(["Itu, Brazil", "Brazil", null]);
    expect(degrausDeLocal(null)).toEqual(["Brazil", null]);
  });
});
