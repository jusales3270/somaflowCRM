// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_APP_NAME, DEFAULT_LOGO_URL, marcaEhAPadraoDaDistribuicao } from "@/lib/branding";
import type { MarcaDeSaida } from "@/lib/branding/saida";

/**
 * O ícone da aba acompanha a marca configurada — e o arquivo do SomaFlow só sai
 * quando a marca É a do SomaFlow.
 *
 * POR QUE ESTE ARQUIVO EXISTE: a distribuição carrega `public/icon.png` e
 * `public/favicon.ico`, e a rota `/icon` devolvia o primeiro SEMPRE. O revendedor
 * trocava nome, cor e logo em `/admin/marca` e o cliente dele seguia vendo a aba
 * do SomaFlow. O CI estava verde o tempo todo: a spec `icone-da-marca` só exige
 * uma imagem PNG, nunca que ela mude com a marca.
 *
 * Por que EXECUTAR a rota, e não ler o texto-fonte: um `toMatch` no arquivo
 * passaria com o `if` escrito errado. Aqui a marca é simulada e a resposta,
 * medida — a mesma forma de `marca-na-fachada-de-acesso.test.tsx`.
 *
 * `ImageResponse` é trocada por uma resposta marcada: renderizar PNG de verdade
 * exige o runtime de imagem do Next, e o que se mede é QUAL RAMO respondeu.
 */

const marcaDaSaida = vi.hoisted(() => vi.fn());
vi.mock("@/lib/branding/saida", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/branding/saida")>();
  return { ...real, marcaDaSaida };
});

vi.mock("next/og", () => {
  class ImageResponse extends Response {
    constructor(
      public readonly elemento: unknown,
      public readonly opcoes: unknown,
    ) {
      super("png-gerado-em-runtime", { headers: { "content-type": "image/png" } });
    }
  }
  return { ImageResponse };
});

const RAIZ = process.cwd();
const ARQUIVO_DA_DISTRIBUICAO = fs.readFileSync(path.join(RAIZ, "public/icon.png"));

const BASE: MarcaDeSaida = {
  nome: DEFAULT_APP_NAME,
  logoUrl: DEFAULT_LOGO_URL,
  accent: "#7a5cd6",
  accentFg: "#ffffff",
  origens: { nome: "padrao", cor: "padrao" },
};

type RespostaGerada = Response & { elemento: unknown };

async function iconeCom(marca: MarcaDeSaida): Promise<Response> {
  marcaDaSaida.mockResolvedValue(marca);
  const { default: Icon } = await import("@/app/icon");
  return Icon();
}

async function bytes(res: Response): Promise<Buffer> {
  return Buffer.from(await res.arrayBuffer());
}

describe("o ícone da aba acompanha a marca", () => {
  beforeEach(() => {
    vi.resetModules();
    marcaDaSaida.mockReset();
  });

  it("marca padrão do SomaFlow (logo semeado): serve o arquivo da distribuição", async () => {
    const res = await iconeCom(BASE);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res).not.toHaveProperty("elemento");
    expect((await bytes(res)).equals(ARQUIVO_DA_DISTRIBUICAO)).toBe(true);
  });

  it("marca padrão sem logo (clone novo, sem APP_LOGO_URL): também serve o arquivo", async () => {
    const res = await iconeCom({ ...BASE, logoUrl: null });
    expect(res).not.toHaveProperty("elemento");
    expect((await bytes(res)).equals(ARQUIVO_DA_DISTRIBUICAO)).toBe(true);
  });

  it("só a cor trocada: continua a marca do SomaFlow, continua o arquivo", async () => {
    const res = await iconeCom({ ...BASE, accent: "#e11d48" });
    expect(res).not.toHaveProperty("elemento");
    expect((await bytes(res)).equals(ARQUIVO_DA_DISTRIBUICAO)).toBe(true);
  });

  it("REVENDA — nome próprio: o arquivo do SomaFlow NÃO sai; sai cor + inicial", async () => {
    const res = (await iconeCom({ ...BASE, nome: "Acme CRM" })) as RespostaGerada;
    expect(res).toHaveProperty("elemento");
    expect((await bytes(res)).equals(ARQUIVO_DA_DISTRIBUICAO)).toBe(false);
    const desenho = JSON.stringify(res.elemento);
    expect(desenho, "a inicial da marca nova").toContain("A");
    expect(desenho, "o accent da marca nova").toContain("#7a5cd6");
  });

  it("REVENDA — logo próprio com o nome padrão: o arquivo do SomaFlow NÃO sai", async () => {
    const res = await iconeCom({ ...BASE, logoUrl: "https://cdn.acme.test/logo.png" });
    expect(res).toHaveProperty("elemento");
    expect((await bytes(res)).equals(ARQUIVO_DA_DISTRIBUICAO)).toBe(false);
  });

  it("REVENDA — nome E logo próprios: gera, com a inicial do nome da revenda", async () => {
    const res = (await iconeCom({
      ...BASE,
      nome: "Ótima Vendas",
      logoUrl: "https://cdn.acme.test/logo.png",
    })) as RespostaGerada;
    expect(res).toHaveProperty("elemento");
    expect(JSON.stringify(res.elemento)).toContain("Ó");
  });

  it("sem o arquivo no disco, a marca padrão ainda tem aba: cai para o ícone desenhado", async () => {
    const real = fs.readFileSync;
    const espiao = vi.spyOn(fs, "readFileSync").mockImplementation(((p: unknown, ...resto: unknown[]) => {
      if (String(p).endsWith(path.join("public", "icon.png"))) throw new Error("ENOENT");
      return (real as (...a: unknown[]) => unknown)(p, ...resto);
    }) as typeof fs.readFileSync);
    try {
      const res = await iconeCom(BASE);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
    } finally {
      espiao.mockRestore();
    }
  });
});

describe("a pergunta 'é a marca padrão da distribuição?'", () => {
  it("só o nome padrão com logo ausente ou padrão conta", () => {
    expect(marcaEhAPadraoDaDistribuicao({ name: DEFAULT_APP_NAME, logoUrl: null })).toBe(true);
    expect(marcaEhAPadraoDaDistribuicao({ name: DEFAULT_APP_NAME, logoUrl: DEFAULT_LOGO_URL })).toBe(true);
    expect(marcaEhAPadraoDaDistribuicao({ name: "Acme", logoUrl: null })).toBe(false);
    expect(marcaEhAPadraoDaDistribuicao({ name: "Acme", logoUrl: DEFAULT_LOGO_URL })).toBe(false);
    expect(marcaEhAPadraoDaDistribuicao({ name: DEFAULT_APP_NAME, logoUrl: "https://x.test/l.png" })).toBe(false);
  });
});

describe("/favicon.ico não é um arquivo da distribuição", () => {
  it("não existe public/favicon.ico — um estático ignora a marca configurada", () => {
    expect(
      fs.existsSync(path.join(RAIZ, "public/favicon.ico")),
      "public/favicon.ico entrega a marca do SomaFlow a todo cliente de revendedor, " +
        "porque o navegador o pede sozinho e arquivo estático não olha o banco",
    ).toBe(false);
  });

  it("o pedido a /favicon.ico é redirecionado para /icon, que segue a marca", () => {
    const config = fs.readFileSync(path.join(RAIZ, "next.config.ts"), "utf8");
    expect(config).toMatch(
      /source:\s*"\/favicon\.ico"\s*,\s*destination:\s*"\/icon"\s*,\s*permanent:\s*false/,
    );
  });
});
