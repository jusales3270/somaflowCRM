import { describe, expect, it } from "vitest";

import {
  buscarCnaes,
  buscarMunicipios,
  CNAES,
  cnaePorCodigo,
  MUNICIPIOS,
  preListaParaIa,
  UFS,
} from "@/lib/prospecting/b2b/catalogos";
import { creditosEstimados, montarConsulta, normalizarEstabelecimento } from "@/lib/prospecting/b2b/cnpja";
import { filtrosB2bSchema, type FiltrosB2b } from "@/lib/prospecting/b2b/schema";
import { conferirFiltros, ErroDaBuscaB2b } from "@/lib/prospecting/b2b/store";
import { codigosDaResposta } from "@/lib/prospecting/b2b/sugerir-cnae";

const filtros = (extra: Partial<FiltrosB2b> = {}): FiltrosB2b =>
  filtrosB2bSchema.parse({ cnaes: ["6201501"], ufs: ["SP"], ...extra });

describe("catálogos oficiais (IBGE) embutidos", () => {
  it("CNAE 2.3 completa: subclasses de 7 dígitos, sem repetição", () => {
    expect(CNAES.length).toBeGreaterThanOrEqual(1300);
    expect(new Set(CNAES.map((c) => c.c)).size).toBe(CNAES.length);
    expect(CNAES.every((c) => /^\d{7}$/.test(c.c) && c.d.length > 0)).toBe(true);
  });

  it("municípios: os 5.570+ com código IBGE de 7 dígitos e as 27 UFs", () => {
    expect(MUNICIPIOS.length).toBeGreaterThanOrEqual(5570);
    expect(new Set(MUNICIPIOS.map((m) => m.i)).size).toBe(MUNICIPIOS.length);
    expect(MUNICIPIOS.every((m) => m.i >= 1000000 && m.i <= 9999999)).toBe(true);
    expect(new Set(MUNICIPIOS.map((m) => m.u))).toEqual(new Set(UFS));
  });

  it("busca CNAE por palavra (sem acento, por raiz) e por código", () => {
    const software = buscarCnaes("desenvolvimento de software e programas de computador").map((c) => c.c);
    expect(software).toContain("6201501");
    expect(buscarCnaes("6201").every((c) => c.c.startsWith("6201"))).toBe(true);
    expect(buscarCnaes("de e para")).toEqual([]);
  });

  it("a busca que a pessoa vê não traz atividade sem relação só por 'sob'", () => {
    const codigos = buscarCnaes("desenvolvimento de software sob encomenda").map((c) => c.c);
    expect(codigos).toContain("6201501");
    // Matadouro "sob contrato" e confecção "sob medida" ficavam na lista antes do corte.
    expect(codigos.some((c) => c.startsWith("101") || c.startsWith("141"))).toBe(false);
  });

  it.each([
    ["indústria de alimentos e bebidas", ["1091101", "1113501", "1122401", "1052000"]],
    ["hospital e clínica médica", ["8610101", "8630501", "8630503"]],
    ["transportadora de cargas", ["4930202"]],
    ["construtora de edifícios", ["4120400"]],
    ["escritório de advocacia e contabilidade", ["6911701", "6920601"]],
  ])("a pré-lista da IA para %s alcança as atividades certas", (descricao, esperados) => {
    const pre = preListaParaIa(descricao).map((c) => c.c);
    expect(pre.length).toBeLessThanOrEqual(120);
    for (const codigo of esperados) expect(pre, codigo).toContain(codigo);
  });

  it("busca cidade por nome, dentro das UFs escolhidas", () => {
    const campinas = buscarMunicipios("campin", ["SP"]);
    expect(campinas[0]).toMatchObject({ i: 3509502, n: "Campinas", u: "SP" });
    expect(buscarMunicipios("campinas", ["MG"]).some((m) => m.n === "Campinas" && m.u === "SP")).toBe(false);
  });
});

describe("filtros → consulta da CNPJá", () => {
  it("padrão: atividade principal, porte Demais (5), só ativas (2), só matriz", () => {
    const q = montarConsulta(filtros());
    expect(Object.fromEntries(q)).toEqual({
      limit: "100",
      "mainActivity.id.in": "6201501",
      "address.state.in": "SP",
      "company.size.id.in": "5",
      "status.id.in": "2",
      "head.eq": "true",
    });
  });

  it("cidade escolhida vence o estado; atividades secundárias; filtros opcionais", () => {
    const q = montarConsulta(
      filtros({
        cnaes: ["6201501", "0111301"],
        tipo_cnae: "qualquer",
        municipios: [3509502],
        portes: [3, 5],
        so_matriz: false,
        nao_optante_simples: true,
        capital_minimo: 500000,
        exige_telefone: true,
        exige_email: true,
      }),
      30,
    );
    const p = Object.fromEntries(q);
    expect(p).toMatchObject({
      limit: "30",
      "activities.id.in": "6201501,111301",
      "address.municipality.in": "3509502",
      "company.size.id.in": "3,5",
      "company.simples.optant.eq": "false",
      "company.equity.gte": "500000",
      "phones.ex": "true",
      "emails.ex": "true",
    });
    expect(p).not.toHaveProperty("address.state.in");
    expect(p).not.toHaveProperty("head.eq");
  });

  it("custo estimado: 1 crédito a cada 10 empresas", () => {
    expect(creditosEstimados(100)).toBe(10);
    expect(creditosEstimados(95)).toBe(10);
  });

  it("o schema exige ao menos um estado ou uma cidade", () => {
    expect(filtrosB2bSchema.safeParse({ cnaes: ["6201501"] }).success).toBe(false);
  });
});

describe("registro da CNPJá → empresa", () => {
  const bruto = {
    taxId: "12.345.678/0001-95",
    alias: "Acme Software",
    founded: "2010-04-01",
    head: true,
    status: { id: 2, text: "Ativa" },
    company: {
      name: "ACME TECNOLOGIA LTDA",
      equity: 1500000,
      nature: { text: "Sociedade Empresária Limitada" },
      size: { id: 5, acronym: "DEMAIS", text: "Demais" },
      simples: { optant: false },
    },
    address: { municipality: 3509502, city: "Campinas", state: "SP" },
    phones: [
      { type: "LANDLINE", area: "19", number: "33334444" },
      { type: "MOBILE", area: "19", number: "999998888" },
    ],
    emails: [
      { ownership: "ACCOUNTING", address: "fiscal@escritoriocontabil.com.br", domain: "escritoriocontabil.com.br" },
      { ownership: "PERSONAL", address: "fulano@gmail.com", domain: "gmail.com" },
      { ownership: "CORPORATE", address: "Contato@AcmeSoftware.com.br", domain: "acmesoftware.com.br" },
    ],
    mainActivity: { id: 6201501, text: "Desenvolvimento de programas de computador sob encomenda" },
    sideActivities: [{ id: 6202300, text: "x" }],
  };

  it("normaliza CNPJ, porte, capital, endereço e telefones", () => {
    expect(normalizarEstabelecimento(bruto)).toMatchObject({
      cnpj: "12345678000195",
      razao_social: "ACME TECNOLOGIA LTDA",
      nome_fantasia: "Acme Software",
      cnae_principal: "6201501",
      cnaes_secundarios: ["6202300"],
      porte_id: 5,
      porte: "DEMAIS",
      capital_social: 1500000,
      simples_optante: false,
      uf: "SP",
      municipio_ibge: 3509502,
      cidade: "Campinas",
      telefones: [
        { numero: "1933334444", tipo: "fixo" },
        { numero: "19999998888", tipo: "celular" },
      ],
    });
  });

  it("minimização (LGPD): só o e-mail corporativo entra — o do contador e o pessoal ficam fora", () => {
    const e = normalizarEstabelecimento(bruto)!;
    expect(e.emails).toEqual(["contato@acmesoftware.com.br"]);
    expect(e.dominio).toBe("acmesoftware.com.br");
  });

  it("registro sem CNPJ válido é descartado", () => {
    expect(normalizarEstabelecimento({ ...bruto, taxId: "123" })).toBeNull();
    expect(normalizarEstabelecimento({ foo: 1 })).toBeNull();
  });
});

describe("conferência dos filtros contra o catálogo", () => {
  it("CNAE inexistente é recusado", () => {
    expect(() => conferirFiltros(filtros({ cnaes: ["9999999"] }))).toThrow(ErroDaBuscaB2b);
  });
  it("cidade fora dos estados escolhidos é recusada", () => {
    expect(() => conferirFiltros(filtros({ ufs: ["MG"], municipios: [3509502] }))).toThrow(/fora dos estados/);
  });
  it("filtro coerente passa", () => {
    expect(() => conferirFiltros(filtros({ municipios: [3509502] }))).not.toThrow();
  });
});

describe("sugestão de CNAE pela IA", () => {
  it("só fica com códigos do catálogo, sem repetir — o inventado some", () => {
    const resposta = `ok {"cnaes":[{"codigo":"6201501","motivo":"software sob encomenda"},{"codigo":"9999999","motivo":"inventado"},{"codigo":"6201-5/01"},{"codigo":"0111301"}]}`;
    expect(codigosDaResposta(resposta)).toEqual([
      { codigo: "6201501", motivo: "software sob encomenda" },
      { codigo: "0111301", motivo: null },
    ]);
    expect(cnaePorCodigo("9999999")).toBeUndefined();
  });
  it("resposta ilegível vira lista vazia, nunca exceção", () => {
    expect(codigosDaResposta("não sei")).toEqual([]);
    expect(codigosDaResposta("{quebrado")).toEqual([]);
  });
});
