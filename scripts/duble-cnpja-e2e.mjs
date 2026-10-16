#!/usr/bin/env node
/**
 * Dublê HTTP da CNPJá para o e2e da prospecção B2B.
 *
 * Servidor de verdade, em processo separado: quem fala com a CNPJá é o servidor
 * Next (lib/prospecting/b2b/cnpja.ts), não o Playwright — um intercept de `fetch`
 * no teste deixaria o produto batendo na internet.
 *
 * Formato do SDK oficial (github.com/cnpja/sdk-nodejs):
 *   GET /credit           → { perpetual, transient } com `Authorization: <chave>`
 *                           igual a DUBLE_CNPJA_CHAVE; 401 com outra.
 *   GET /office?<filtros> → { next, limit, count: 25, records[] } — páginas do
 *                           tamanho de `limit`; `GET /office?token=<next>` segue
 *                           de onde parou, até as 25.
 *                           Um e-mail de CONTABILIDADE e um PESSOAL vêm junto, para
 *                           a spec provar que a minimização os tira.
 *   GET /__duble/saude    → { ok, porta } — a spec confere que é o dublê dela.
 *
 * GRAVA cada consulta (caminho + parâmetros, nunca a chave) em DUBLE_CNPJA_ARQUIVO.
 * Zero dependências. Uso:
 *   DUBLE_CNPJA_ARQUIVO=/tmp/chamadas.json node scripts/duble-cnpja-e2e.mjs
 */
import { writeFileSync } from "node:fs";
import http from "node:http";

/** 3994: vizinha de 3995 (cobrança), 3996 (Jev), 3997 (SaaS), 3998 (Redis HTTP), 3999 (WAHA). */
const PORTA = Number(process.env.DUBLE_CNPJA_PORTA ?? 3994);
const CHAVE = process.env.DUBLE_CNPJA_CHAVE ?? "chave-e2e-cnpja";
const ARQUIVO = process.env.DUBLE_CNPJA_ARQUIVO ?? "";
const chamadas = [];
/** Quantas empresas o dublê tem para a busca: 25, em páginas do tamanho pedido. */
const TOTAL = 25;

function gravar(caminho, params, autorizada) {
  chamadas.push({ caminho, params, autorizada });
  if (ARQUIVO) writeFileSync(ARQUIVO, JSON.stringify(chamadas, null, 2));
}

function empresa(n, municipio, estado, cidade, atividade) {
  const base = String(10000000 + n).padStart(8, "0");
  return {
    taxId: `${base}0001${String(n % 10)}${String((n * 3) % 10)}`,
    updated: "2026-10-01T00:00:00.000Z",
    alias: n % 2 ? `Empresa Teste ${n}` : null,
    founded: "2012-05-10",
    head: true,
    status: { id: 2, text: "Ativa" },
    company: {
      id: 10000000 + n,
      name: `EMPRESA TESTE ${n} LTDA`,
      equity: 500000 * n,
      nature: { id: 2062, text: "Sociedade Empresária Limitada" },
      size: { id: 5, acronym: "DEMAIS", text: "Demais" },
      simples: { optant: false, since: null },
      members: [],
    },
    address: { municipality: municipio, city: cidade, state: estado, street: "Rua Teste", number: String(n), district: "Centro", zip: "13000000", country: { id: 76, name: "Brasil" } },
    phones: [
      { type: "LANDLINE", area: "19", number: `3${String(3000000 + n)}` },
      { type: "MOBILE", area: "19", number: `9${String(80000000 + n)}` },
    ],
    emails: [
      { ownership: "ACCOUNTING", address: `fiscal${n}@contabilidade-teste.com.br`, domain: "contabilidade-teste.com.br" },
      { ownership: "PERSONAL", address: `socio${n}@gmail.com`, domain: "gmail.com" },
      { ownership: "CORPORATE", address: `contato@empresa${n}-teste.com.br`, domain: `empresa${n}-teste.com.br` },
    ],
    mainActivity: { id: Number(atividade), text: "Desenvolvimento de programas de computador sob encomenda" },
    sideActivities: [],
  };
}

// Saldo que DESCONTA, como a conta real: 1 crédito a cada 10 empresas entregues.
// Sem isso, a tela poderia mostrar o saldo de antes da busca e o teste não veria.
let saldo = 500;

const servidor = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORTA}`);
  const responder = (status, corpo) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(corpo));
  };
  if (url.pathname === "/__duble/saude") return responder(200, { ok: true, porta: PORTA });
  const autorizada = req.headers.authorization === CHAVE;
  gravar(url.pathname, Object.fromEntries(url.searchParams), autorizada);
  if (!autorizada) return responder(401, { code: 401, message: "Unauthorized" });
  if (url.pathname === "/credit") return responder(200, { perpetual: saldo, transient: 0 });
  if (url.pathname === "/office") {
    // O token carrega a consulta da primeira página e onde ela parou, como na
    // API real ("token é exclusivo": a página seguinte vem só com ele).
    const token = url.searchParams.get("token");
    const consulta = token ? JSON.parse(Buffer.from(token, "base64url").toString("utf8")) : {
      municipio: Number((url.searchParams.get("address.municipality.in") ?? "3509502").split(",")[0]),
      atividade: (url.searchParams.get("mainActivity.id.in") ?? url.searchParams.get("activities.id.in") ?? "6201501").split(",")[0],
      estado: (url.searchParams.get("address.state.in") ?? "SP").split(",")[0],
      tamanho: Math.min(100, Number(url.searchParams.get("limit") ?? 100)),
      inicio: 0,
    };
    const fim = Math.min(TOTAL, consulta.inicio + consulta.tamanho);
    const records = [];
    for (let n = consulta.inicio + 1; n <= fim; n += 1)
      records.push(empresa(n, consulta.municipio, consulta.estado, "Campinas", consulta.atividade));
    saldo -= Math.ceil(records.length / 10);
    const next = fim < TOTAL ? Buffer.from(JSON.stringify({ ...consulta, inicio: fim })).toString("base64url") : null;
    return responder(200, { next, limit: consulta.tamanho, count: TOTAL, records });
  }
  return responder(404, { code: 404, message: "Not Found" });
});

servidor.listen(PORTA, "127.0.0.1", () => {
  process.stdout.write(`duble-cnpja ouvindo em 127.0.0.1:${PORTA}\n`);
});
for (const sinal of ["SIGTERM", "SIGINT"]) process.on(sinal, () => servidor.close(() => process.exit(0)));
