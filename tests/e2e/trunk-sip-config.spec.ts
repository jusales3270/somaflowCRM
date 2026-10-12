import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Page } from "./helpers/test";

import { generateTotp, msUntilNextTotpWindow } from "./utils/totp";

/**
 * TRUNK SIP — só admin escreve, manager só lê, salvar mostra o resultado da
 * aplicação no Asterisk e o estado da conexão, e salvar de novo SEM redigitar a
 * senha funciona.
 *
 * ## Por que dois papéis, não um
 *
 * A rota (`app/api/v1/voip/trunk/route.ts`) e a tela
 * (`app/app/settings/voip-trunk/_client.tsx`) concordam em dois eixos
 * diferentes: leitura exige `manager`+, escrita exige `admin`. Testar só com
 * admin não prova o primeiro eixo — um `canWrite` sempre `true` passaria do
 * mesmo jeito. `manager` é quem prova que os campos ficam desabilitados e o
 * botão Salvar não aparece, sem precisar de um segundo usuário sem conta
 * nenhuma (RLS/RBAC de leitura já é medido em `tests/invariants/rls-isolation.test.ts`).
 *
 * ## Não há mais bloco para colar
 *
 * Salvar aplica o tronco no Asterisk pela ARI (`lib/voip/tronco-no-asterisk.ts`).
 * No CI não há Asterisk (o profile `telefonia` não sobe), então o que esta spec
 * mede é o caminho de quem ainda não ligou a telefonia: salvo, com a tela dizendo
 * que o tronco entra no ar quando ela for ligada — e o card de estado dizendo o
 * mesmo. O caminho com Asterisk (Conectado / Recusado / reconciliação) foi
 * provado à mão contra um Asterisk 20.20.1 e um provedor SIP de teste
 * (`docs/telefonia-tronco-sip.md`), e a montagem dos objetos e da AMI em
 * `tests/unit/voip-tronco-no-asterisk.test.ts`.
 *
 * ## Salvar sem redigitar a senha
 *
 * "Deixe em branco para manter a atual" dava 500 (upsert sem as colunas NOT NULL
 * de senha). O segundo salvar desta spec é a regressão.
 *
 * ## O que esta spec NÃO prova
 *
 * Não fala com Asterisk nem faz ligação — isso depende do profile `telefonia`
 * e de um provedor SIP (mesmo limite do `voz-desligada-por-padrao.spec.ts`).
 *
 * Pré-requisitos (banco local, app buildada):
 *   pnpm exec tsx scripts/seed-e2e-credentials.ts
 *   pnpm e2e:env && pnpm e2e:build
 *   E2E_PORT=3031 pnpm exec playwright test tests/e2e/trunk-sip-config.spec.ts
 */
const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), "e2e-artifacts");
fs.mkdirSync(EVIDENCIA, { recursive: true });

interface Creds {
  password: string;
  users: Record<string, { email: string } | undefined>;
  admin_totp?: { factor_id: string; secret: string };
}

function loadCreds(): Creds {
  const precisaSemear = (): boolean => {
    if (!fs.existsSync(CREDS_PATH)) return true;
    const c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    return !c.users?.admin;
  };
  if (precisaSemear()) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
}

const creds = loadCreds();

/** Admin do seed tem TOTP verified sempre — o login para em `/login/mfa`. */
async function entrarComoAdmin(page: Page): Promise<void> {
  const usuario = creds.users.admin;
  const segredo = creds.admin_totp?.secret;
  expect(usuario, ".e2e-creds.json sem o usuário `admin`").toBeTruthy();
  expect(segredo, "o seed não trouxe o segredo TOTP do admin — sem ele não há como entrar").toBeTruthy();

  await page.goto("/login");
  await page.locator("#email").fill(usuario!.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/login\/mfa/);

  for (let tentativa = 0; tentativa < 2; tentativa += 1) {
    if (msUntilNextTotpWindow() < 3_000) {
      await page.waitForTimeout(msUntilNextTotpWindow() + 200);
    }
    await page.locator('input[aria-label="Dígito 1"]').click();
    await page.keyboard.type(generateTotp(segredo as string), { delay: 40 });
    try {
      await page.waitForURL(/\/app\//, { timeout: 8_000 });
      return;
    } catch {
      await page.waitForTimeout(msUntilNextTotpWindow() + 200);
    }
  }
  throw new Error("MFA do admin não passou em 2 tentativas de TOTP");
}

/** `manager` não tem TOTP — a tela de 2FA não é o assunto desta spec. */
async function entrarComoManager(page: Page): Promise<void> {
  const usuario = creds.users.manager;
  expect(usuario, ".e2e-creds.json sem o usuário `manager`").toBeTruthy();
  await page.goto("/login");
  await page.locator("#email").fill(usuario!.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 20_000 });
}

test.describe("trunk SIP — permissão, aplicação e estado", () => {
  test("admin chega pela navegação, salva, vê o resultado e o estado, e salva de novo sem a senha", async ({
    page,
  }) => {
    await entrarComoAdmin(page);

    // ── CHEGADA PELA NAVEGAÇÃO, não por goto (DoD 14) ──────────────────────
    await page.goto("/app/settings");
    const porta = page.locator('a[href="/app/settings/voip-trunk"]').first();
    await expect(porta, "não há porta para Trunk SIP em Configurações").toBeVisible();
    await porta.click();
    await page.waitForURL(/\/app\/settings\/voip-trunk/);

    // ── VALORES ÚNICOS por execução: reconhecíveis no bloco final ──────────
    // O sufixo sempre inclui um dígito ('1') para impedir que <sufixo>.invariant.test
    // forme três segmentos exclusivamente alfabéticos pontuados (#1434).
    const sufixo = `${Date.now().toString(36)}1`;
    const host = `sip-e2e-${sufixo}.invariant.test`;
    const usuario = `e2e-user-${sufixo}`;
    const senha = `e2e-senha-${sufixo}`;

    await page.locator("#host").fill(host);
    await page.locator("#username").fill(usuario);
    await page.locator("#password").fill(senha);
    const salvar = async () => {
      const resposta = page.waitForResponse(
        (r) => r.url().endsWith("/api/v1/voip/trunk") && r.request().method() === "PUT",
      );
      await page.getByRole("button", { name: /^Salvar$/ }).click();
      return resposta;
    };

    const primeira = await salvar();
    expect(primeira.status(), "salvar o tronco pela primeira vez falhou").toBe(200);
    const resultado = page.getByTestId("resultado-da-aplicacao");
    // Sem Asterisk no CI: salvo, e a tela diz que entra no ar quando a telefonia for ligada.
    await expect(resultado).toContainText("Salvo", { timeout: 10_000 });
    await expect(resultado).toContainText("telefonia não está ligada");
    const estado = page.locator('[data-testid="status-do-tronco"] [data-estado]');
    await expect(estado).toHaveAttribute("data-estado", "sem_telefonia", { timeout: 10_000 });

    // A senha não volta para a tela: o campo esvazia e só os últimos 4 aparecem.
    await expect(page.locator("#password")).toHaveValue("");
    await expect(page.getByText(`termina em ${senha.slice(-4)}`)).toBeVisible();

    // REGRESSÃO do 500: salvar de novo SEM redigitar a senha (desativando).
    await page.locator("#is_active").click();
    const segunda = await salvar();
    expect(segunda.status(), "salvar sem redigitar a senha voltou a dar erro").toBe(200);
    await expect(estado).toHaveAttribute("data-estado", "sem_telefonia");

    // ── QUALIDADE DE TELA ────────────────────────────────────────────────
    // O BLOCO SAI DA VARREDURA, e não é conveniência: a guarda abaixo é sobre a
    // CÓPIA da tela, e um arquivo `.conf` tem token pontuado em minúsculas por
    // construção. Medido: `sufixo` é `Date.now().toString(36)`, então o host
    // gerado (`sip-e2e-<sufixo>.invariant.test`) casa com o padrão de chave crua
    // toda vez que o relógio devolve base36 só com letras (#1434) — o caso reprovava por
    // hora do dia, e passava na hora seguinte. Além de excluir o bloco, limpamos o host
    // e garantimos dígito no sufixo.
    const corpo = (await page.locator("body").innerText()).trim();
    const corpoSemOBloco = corpo.replaceAll(host, "").replaceAll(usuario, "").trim();
    expect(corpoSemOBloco, "a tela mostra o que parece uma chave de tradução crua").not.toMatch(
      /\b[a-z]+(?:[._][a-z]+){2,}\b/,
    );
    expect(corpo).not.toMatch(/\{\{|\}\}|undefined|NaN|\[object Object\]/);

    const estouro = await page.evaluate(() => {
      const doc = document.documentElement;
      return { scroll: doc.scrollWidth, cliente: doc.clientWidth };
    });
    expect(
      estouro.scroll,
      `a página rola na horizontal (${estouro.scroll}px de conteúdo para ${estouro.cliente}px de tela)`,
    ).toBeLessThanOrEqual(estouro.cliente + 1);

    await page.screenshot({
      path: path.join(EVIDENCIA, "trunk-sip-admin-salvo.png"),
      fullPage: true,
    });
  });

  test("manager só lê: campos desabilitados e sem botão Salvar", async ({ page }) => {
    await entrarComoManager(page);

    // Direto por URL: o item de navegação é `minRole: admin`
    // (lib/navigation/catalogo.ts) — manager não tem porta pra chegar aqui
    // andando, mas a rota/tela continuam acessíveis (defesa em profundidade,
    // mesmo padrão de outras telas admin-write/manager-read do produto).
    await page.goto("/app/settings/voip-trunk");
    await expect(page.locator("#host")).toBeVisible();

    await expect(page.locator("#host")).toBeDisabled();
    await expect(page.locator("#username")).toBeDisabled();
    await expect(page.locator("#password")).toBeDisabled();
    await expect(
      page.getByRole("button", { name: /^Salvar$/ }),
      "manager viu o botão Salvar — a tela ofereceria uma escrita que a API rejeitaria (403)",
    ).toHaveCount(0);
  });
});
