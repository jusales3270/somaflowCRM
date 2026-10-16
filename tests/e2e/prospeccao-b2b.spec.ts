/**
 * PROSPECÇÃO B2B POR CNPJ — a prova pela tela (DoD 12).
 *
 * O que a pessoa faz, e o que esta spec mede a cada passo:
 *   1. Abre Prospecção: o padrão continua o Google Maps (o motor de sempre, intacto).
 *   2. Troca para "Empresas B2B (CNPJ)", salva a chave da CNPJá e vê o saldo.
 *   3. Descreve o tipo de empresa e pede os CNAEs; marca o sugerido.
 *   4. Escolhe estado e cidade; o porte "Demais" (acima de R$ 4,8 mi/ano) já vem marcado.
 *   5. Busca: a tabela mostra as empresas, e o dublê RECEBEU os filtros certos
 *      (CNAE, município IBGE, porte 5, situação ativa) — a tela não decide sozinha.
 *   6. A busca para no teto pedido e guarda o token; "Carregar mais" continua dele.
 *   7. Desmarca uma empresa e exporta: o CSV tem só as marcadas e NÃO tem o e-mail
 *      da contabilidade nem o pessoal (minimização).
 *   8. Cola a chave do Jev em IA › Provedores e volta: "Dar nota com o Jev" dá nota
 *      a todas, e o Jev recebeu só dado público de empresa (nada de contato).
 *   9. Salva o token do Treg e busca decisores com teto de US$ 0,10: a rodada para
 *      SOZINHA no teto ("Parou no teto de gasto"), os decisores aparecem na
 *      tabela, e toda chamada saiu com teto por chamada e chave de idempotência.
 *  10. Remove um decisor ("não buscar de novo") e exporta: uma linha por decisor.
 *  11. Uso e orçamento mostra o custo da CNPJá e do Treg.
 *
 * Os provedores são dublês: CNPJá (`scripts/duble-cnpja-e2e.mjs`, porta 3994),
 * Treg (`scripts/duble-treg-e2e.mjs`, 3993) e Jev (`scripts/duble-jev-e2e.mjs`,
 * 3996) — as bases vêm do `.env.e2e`; quem fala com eles é o servidor Next.
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { limparOJev } from "./helpers/jev";
import { lerCreds, loginComoAdmin } from "./helpers/login-admin";
import { expect, test } from "./helpers/test";

const ARQUIVO = path.join(os.tmpdir(), `duble-cnpja-e2e-${process.pid}.json`);
const EVIDENCIA = path.join(process.cwd(), "evidence", "prospeccao-b2b");
const CHAVE = "chave-e2e-cnpja";
const ARQUIVO_TREG = path.join(os.tmpdir(), `duble-treg-e2e-${process.pid}.json`);
const TOKEN_TREG = "treg_e2e_duble_0123456789";
const ARQUIVO_JEV = path.join(os.tmpdir(), `duble-jev-e2e-b2b-${process.pid}.json`);
const CHAVE_JEV = "apikey_e2e_duble_do_jev_0123456789abcdef";
const duboes: ChildProcess[] = [];
let orgId = "";

function chamadas(): Array<{ caminho: string; params: Record<string, string>; autorizada: boolean }> {
  return fs.existsSync(ARQUIVO) ? JSON.parse(fs.readFileSync(ARQUIVO, "utf8")) : [];
}
function chamadasDoTreg(): Array<{ caminho: string; autorizada: boolean; corpo: Record<string, unknown>; teto: string | null; chave: string | null; meta: string | null }> {
  return fs.existsSync(ARQUIVO_TREG) ? JSON.parse(fs.readFileSync(ARQUIVO_TREG, "utf8")) : [];
}
function chamadasDoJev(): Array<{ caminho: string; corpo: { state?: unknown; questions?: Record<string, unknown> } }> {
  return fs.existsSync(ARQUIVO_JEV) ? JSON.parse(fs.readFileSync(ARQUIVO_JEV, "utf8")) : [];
}

/** As buscas desta spec de rodadas anteriores (banco reaproveitado): sem elas, o seletor pega a velha. */
async function limparBuscasDeTeste(org: string): Promise<void> {
  const { url, serviceRole } = credenciaisSupabaseDeTeste();
  const admin = createClient(url, serviceRole, { auth: { persistSession: false } });
  const { error } = await admin
    .from("prospecting_b2b_searches")
    .delete()
    .eq("organization_id", org)
    .eq("name", "Software em Campinas");
  if (error) throw new Error(`limpar buscas de teste: ${error.message}`);
}

async function subir(script: string, env: Record<string, string>, saude: string, nome: string) {
  duboes.push(spawn(process.execPath, [script], { env: { ...process.env, ...env }, stdio: "ignore" }));
  for (let i = 0; i < 50; i += 1) {
    try {
      const r = await fetch(saude);
      if (r.ok) return;
    } catch {
      /* ainda subindo */
    }
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error(`o dublê ${nome} não subiu (${saude})`);
}

test.describe("prospecção B2B por CNPJ", () => {
  test.describe.configure({ mode: "serial", timeout: 180_000 });

  test.beforeAll(async () => {
    for (const f of [ARQUIVO, ARQUIVO_TREG, ARQUIVO_JEV]) fs.rmSync(f, { force: true });
    fs.mkdirSync(EVIDENCIA, { recursive: true });
    await subir("scripts/duble-cnpja-e2e.mjs", { DUBLE_CNPJA_ARQUIVO: ARQUIVO, DUBLE_CNPJA_CHAVE: CHAVE }, "http://127.0.0.1:3994/__duble/saude", "da CNPJá");
    await subir("scripts/duble-treg-e2e.mjs", { DUBLE_TREG_ARQUIVO: ARQUIVO_TREG, DUBLE_TREG_CHAVE: TOKEN_TREG }, "http://127.0.0.1:3993/__duble/saude", "do Treg");
    await subir(
      "scripts/duble-jev-e2e.mjs",
      { DUBLE_JEV_ARQUIVO: ARQUIVO_JEV, DUBLE_JEV_CHAVE: CHAVE_JEV, DUBLE_JEV_PORTA: "3996", DUBLE_JEV_HOST: "127.0.0.1" },
      "http://127.0.0.1:3996/__duble/saude",
      "do Jev",
    );
    // O `.e2e-creds.json` traz a organização do admin (o tipo não a declara; `helpers/jev.ts` lê igual).
    orgId = (lerCreds() as unknown as { org_id: string }).org_id;
    await limparOJev(orgId);
    await limparBuscasDeTeste(orgId);
  });

  test.afterAll(async () => {
    for (const d of duboes) d.kill("SIGTERM");
    if (orgId) await limparOJev(orgId);
  });

  test("busca por CNAE, cidade e porte; carrega mais; exporta só as marcadas", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await loginComoAdmin(page, lerCreds());

    // 1. O padrão continua o Google Maps.
    await page.goto("/app/prospecting");
    const niveis = page.getByRole("navigation", { name: "Nível de prospecção" });
    await expect(niveis.getByRole("link", { name: "Negócios locais (Google Maps)" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByText("1. Encontrar empresas")).toBeVisible();

    // 2. Nível B2B e a chave.
    await niveis.getByRole("link", { name: "Empresas B2B (CNPJ)" }).click();
    await page.waitForURL(/nivel=b2b/);
    const b2b = page.getByTestId("prospeccao-b2b");
    await expect(b2b).toBeVisible();
    await page.locator("#b2b-chave").fill(CHAVE);
    await b2b.getByRole("button", { name: "Salvar", exact: true }).click();
    await expect(page.getByTestId("b2b-saldo")).toHaveText("500 créditos disponíveis");

    // 3. Descrição → CNAE sugerido.
    await page.locator("#b2b-nome").fill("Software em Campinas");
    await page.locator("#b2b-descricao").fill("empresas de desenvolvimento de software e programas de computador sob encomenda");
    await b2b.getByRole("button", { name: "Sugerir CNAEs" }).click();
    const sugeridos = page.getByTestId("b2b-sugeridos");
    await expect(sugeridos).toContainText("6201501", { timeout: 30_000 });
    await sugeridos.locator("label", { hasText: "6201501" }).locator("input").check();
    await expect(page.getByTestId("b2b-cnaes-escolhidos")).toContainText("6201501");

    // 4. Estado e cidade; porte Demais já vem marcado.
    await page.getByTestId("b2b-ufs").getByRole("button", { name: "SP", exact: true }).click();
    await page.locator("#b2b-cidade").fill("Campinas");
    await b2b.getByRole("button", { name: "Campinas/SP", exact: true }).click();
    await expect(page.getByTestId("b2b-cidades")).toContainText("Campinas/SP");
    await expect(b2b.getByLabel("Acima de R$ 4,8 milhões por ano (porte Demais)")).toBeChecked();
    await page.locator("#b2b-maximo").fill("10");
    await expect(page.getByTestId("b2b-custo")).toContainText("1 crédito da CNPJá");
    await page.screenshot({ path: path.join(EVIDENCIA, "01-perfil.png"), fullPage: true });

    // 5. Busca.
    await b2b.getByRole("button", { name: "Buscar empresas" }).click();
    const tabela = page.getByTestId("b2b-tabela");
    await expect(tabela.locator("tbody tr")).toHaveCount(10, { timeout: 30_000 });
    await expect(page.getByTestId("b2b-resumo")).toContainText("10 empresas de 25 disponíveis");
    // A busca gastou 1 crédito: o saldo mostrado no topo acompanha (achado no teste
    // real de 16/10/2026 — a tela seguia mostrando o saldo de antes da busca).
    await expect(page.getByTestId("b2b-saldo")).toHaveText("499 créditos disponíveis");
    const busca = chamadas().find((c) => c.caminho === "/office" && !c.params.token);
    expect(busca?.autorizada, "a busca saiu sem a chave salva").toBe(true);
    expect(busca?.params).toMatchObject({
      "mainActivity.id.in": "6201501",
      "address.municipality.in": "3509502",
      "company.size.id.in": "5",
      "status.id.in": "2",
      "head.eq": "true",
      limit: "10",
    });

    // 6. Carregar mais, pelo token (a busca encheu o teto e guardou a página seguinte).
    await b2b.getByRole("button", { name: "Carregar mais" }).click();
    await expect(tabela.locator("tbody tr")).toHaveCount(20, { timeout: 30_000 });
    await expect(page.getByTestId("b2b-saldo")).toHaveText("498 créditos disponíveis");
    expect(chamadas().some((c) => c.caminho === "/office" && !!c.params.token)).toBe(true);

    // 7. Desmarca uma e exporta.
    // `click` + espera, e não `uncheck`: a caixa muda pela atualização otimista do
    // cache (um quadro depois do clique), e o `uncheck` confere no mesmo instante.
    const primeira = tabela.locator("tbody tr").first().locator("input[type=checkbox]");
    await primeira.click();
    await expect(primeira).not.toBeChecked();
    const exportar = page.getByTestId("b2b-exportar");
    await expect(exportar).toContainText("(19)");
    await page.screenshot({ path: path.join(EVIDENCIA, "02-resultados.png"), fullPage: true });
    const resposta = await page.request.get((await exportar.getAttribute("href"))!);
    expect(resposta.status()).toBe(200);
    expect(resposta.headers()["content-type"]).toContain("text/csv");
    const csv = await resposta.text();
    const linhas = csv.replace(/^﻿/, "").trim().split(/\r?\n/);
    expect(linhas[0]).toContain("CNPJ;Razão social");
    expect(linhas).toHaveLength(1 + 19);
    expect(csv).toContain("contato@empresa");
    expect(csv, "e-mail da contabilidade não pode sair").not.toContain("contabilidade-teste");
    expect(csv, "e-mail pessoal não pode sair").not.toContain("@gmail.com");

    // 8. Jev: a chave em IA › Provedores, e a nota na lista.
    await page.goto("/app/ai/providers");
    const cartao = page.getByTestId("cartao-do-jev");
    await expect(cartao).toBeVisible({ timeout: 30_000 });
    await cartao.getByRole("button", { name: "Colar a chave" }).click();
    await page.locator("#cred-key").fill(CHAVE_JEV);
    const [criou] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/v1/ai/credentials") && r.request().method() === "POST"),
      page.getByRole("button", { name: /salvar e validar/i }).click(),
    ]);
    expect(criou.status(), "a chave do Jev não foi cadastrada").toBe(201);
    await page.goto("/app/prospecting?nivel=b2b");
    await expect(page.getByTestId("b2b-jev-estado")).toContainText("Chave do Jev cadastrada");
    await page.getByRole("combobox", { name: "Busca" }).selectOption({ label: "Software em Campinas — 20 empresas" });
    await expect(tabela.locator("tbody tr")).toHaveCount(20, { timeout: 30_000 });
    await b2b.getByRole("button", { name: /Dar nota com o Jev/ }).click();
    await expect(b2b.getByRole("button", { name: "Todas com nota" })).toBeVisible({ timeout: 60_000 });
    await expect(tabela.locator("tbody tr").first()).toContainText(/Alta|Média|Baixa/);
    const doJev = chamadasDoJev().filter((c) => c.caminho === "/v1/systemone");
    expect(doJev.length, "o Jev não foi chamado (ou foi uma vez por empresa)").toBe(2);
    const estadoEnviado = JSON.stringify(doJev.map((c) => c.corpo.state));
    expect(Object.keys(doJev[0]!.corpo.questions ?? {})[0]).toMatch(/^aderencia_\d{14}$/);
    expect(estadoEnviado, "telefone de empresa não vai para o Jev").not.toContain("telefones");
    expect(estadoEnviado, "e-mail não vai para o Jev").not.toContain("@");
    await b2b.getByRole("combobox", { name: "Filtrar por nota" }).selectOption("alta");
    await expect(page.getByText(/Mostrando \d+ de 20/)).toBeVisible();
    await b2b.getByRole("combobox", { name: "Filtrar por nota" }).selectOption("todas");

    // 9. Treg: token, e decisores com teto baixo — a rodada para sozinha nele.
    await page.locator("#b2b-treg").fill(TOKEN_TREG);
    await b2b.getByRole("button", { name: "Salvar token" }).click();
    await expect(page.getByTestId("b2b-treg-estado")).toHaveText("Token do Treg válido");
    const decisores = page.getByTestId("b2b-decisores");
    await decisores.locator("#b2b-teto").fill("0.10");
    await decisores.getByRole("button", { name: /Buscar decisores/ }).click();
    const progresso = page.getByTestId("b2b-decisores-progresso");
    await expect(progresso).toContainText("Parou no teto de gasto", { timeout: 90_000 });
    await expect(progresso).toContainText("4 decisores");
    await expect(progresso).toContainText("US$ 0,10 de US$ 0,10");
    const doTreg = chamadasDoTreg().filter((c) => c.caminho.startsWith("/call/"));
    expect(doTreg.every((c) => c.autorizada), "chamada ao Treg sem o token salvo").toBe(true);
    expect(doTreg.every((c) => !!c.chave && !!c.teto), "toda chamada leva teto e chave de idempotência").toBe(true);
    expect(doTreg.every((c) => Number(c.teto) <= 0.1), "o teto por chamada nunca passa do que falta da rodada").toBe(true);
    expect(doTreg.every((c) => c.meta?.includes(`customer=${orgId}`)), "a chamada é marcada com a organização").toBe(true);
    const comDecisor = page.getByTestId("b2b-decisores-da-empresa").filter({ hasText: "(verificado)" });
    await expect(comDecisor).toHaveCount(4);
    await page.screenshot({ path: path.join(EVIDENCIA, "03-decisores.png"), fullPage: true });

    // 10. Remove um decisor (não buscar de novo) e exporta: uma linha por decisor.
    const primeiro = comDecisor.first();
    await primeiro.getByRole("button", { name: /Remover e não buscar de novo/ }).click();
    await expect(comDecisor).toHaveCount(3);
    const csv2 = await (await page.request.get((await exportar.getAttribute("href"))!)).text();
    expect(csv2).toContain("Decisor;Cargo;E-mail do decisor");
    expect(csv2.match(/;verificado;/g)?.length, "três decisores verificados no CSV").toBe(3);

    // 11. Uso e orçamento: o custo da CNPJá e do Treg, fora do teto de IA.
    await page.goto("/app/ai/usage");
    const custo = page.getByTestId("custo-dos-provedores");
    await expect(custo).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("custo-cnpja")).toContainText("R$");
    // Números exatos não: o banco local acumula rodadas anteriores da suíte.
    await expect(custo).toContainText(/\d+ créditos/);
    await expect(custo).toContainText(/\d+ consultas cobradas/);
    await expect(custo.locator("text=/NaN|undefined|Infinity/")).toHaveCount(0);
    await custo.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(EVIDENCIA, "04-uso-e-orcamento.png") });

    // O Google Maps continua lá, do jeito que era.
    await page.goto("/app/prospecting");
    await page.getByRole("navigation", { name: "Nível de prospecção" }).getByRole("link", { name: "Negócios locais (Google Maps)" }).click();
    await expect(page.getByText("1. Encontrar empresas")).toBeVisible();
  });
});
