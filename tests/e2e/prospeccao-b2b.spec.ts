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
 *
 * A CNPJá é o dublê `scripts/duble-cnpja-e2e.mjs` (porta 3994, `CNPJA_API_BASE_URL`
 * do `.env.e2e`): quem fala com ela é o servidor Next.
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { lerCreds, loginComoAdmin } from "./helpers/login-admin";
import { expect, test } from "./helpers/test";

const ARQUIVO = path.join(os.tmpdir(), `duble-cnpja-e2e-${process.pid}.json`);
const EVIDENCIA = path.join(process.cwd(), "evidence", "prospeccao-b2b");
const CHAVE = "chave-e2e-cnpja";
let duble: ChildProcess | undefined;

function chamadas(): Array<{ caminho: string; params: Record<string, string>; autorizada: boolean }> {
  return fs.existsSync(ARQUIVO) ? JSON.parse(fs.readFileSync(ARQUIVO, "utf8")) : [];
}

test.describe("prospecção B2B por CNPJ", () => {
  test.describe.configure({ mode: "serial", timeout: 180_000 });

  test.beforeAll(async () => {
    fs.rmSync(ARQUIVO, { force: true });
    fs.mkdirSync(EVIDENCIA, { recursive: true });
    duble = spawn(process.execPath, ["scripts/duble-cnpja-e2e.mjs"], {
      env: { ...process.env, DUBLE_CNPJA_ARQUIVO: ARQUIVO, DUBLE_CNPJA_CHAVE: CHAVE },
      stdio: "ignore",
    });
    for (let i = 0; i < 50; i += 1) {
      try {
        const r = await fetch("http://127.0.0.1:3994/__duble/saude");
        if (r.ok) return;
      } catch {
        /* ainda subindo */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("o dublê da CNPJá não subiu na porta 3994");
  });

  test.afterAll(() => {
    duble?.kill("SIGTERM");
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

    // O Google Maps continua lá, do jeito que era.
    await niveis.getByRole("link", { name: "Negócios locais (Google Maps)" }).click();
    await expect(page.getByText("1. Encontrar empresas")).toBeVisible();
  });
});
