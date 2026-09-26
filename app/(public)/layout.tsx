import { marcaDaSaida } from "@/lib/branding/saida";
import { createClient } from "@/lib/supabase/server";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";

/**
 * A casca das telas de acesso — login, cadastro, recuperação, MFA.
 *
 * ── Por que o LOGO mora aqui, e não em `login/page.tsx` ───────────────────────
 *
 * São seis telas no grupo `(public)`, e todas são "antes de entrar": quem instala
 * o produto para clientes mostra a marca dele exatamente aí. Um `<img>` por
 * página seriam seis cópias que divergem na primeira vez que alguém mexer numa
 * só — e a que ficaria para trás é sempre a que ninguém abre (recuperação de
 * senha, cadastro de MFA), que é justamente onde o cliente do revendedor
 * aparece sozinho e sem contexto.
 *
 * ── Por que `marcaDaSaida(null)` ──────────────────────────────────────────────
 *
 * Aqui não existe organização resolvida: `null` é a declaração disso, e a pilha
 * resultante é a mesma do layout raiz (banco acima, `.env` embaixo). Montar a
 * pilha à mão nesta tela faria a fachada anunciar uma precedência que o resto do
 * produto não usa. E `marcaDaSaida` NUNCA lança (ver o cabeçalho dela): uma cor
 * ou um logo mal gravados não podem derrubar a única tela por onde se entra para
 * corrigi-los.
 *
 * Sem logo configurado E com o nome padrão, a fachada mostra o logotipo do
 * PRODUTO (`components/branding/MarcaDoProduto.tsx`) — inline, sem `<img>`,
 * para que `tests/e2e/marca-logo.spec.ts` continue medindo "a fachada está sem
 * `<img>`" como "sem logo do revendedor".
 *
 * O NOME continua saindo de `branding()` dentro de cada página — não é descuido,
 * está medido em `tests/e2e/icone-da-marca.spec.ts:64-77`: aquela spec cruza duas
 * resoluções independentes (o título da aba, que lê o banco, contra o texto sob
 * o "Entrar", que lê o `.env`). Trocar o texto para este mesmo resolvedor
 * deixaria a spec verde medindo nada.
 */
import { ThreeDMarquee } from "@/components/ui/three-d-marquee";
import { PublicAuthShell } from "@/components/auth/PublicAuthShell";
import type { MarcaDeSaida } from "@/lib/branding/saida";

/**
 * O logo do operador, montado AQUI e entregue pronto ao `PublicAuthShell` (que só
 * o posiciona e anima). Sem arte própria para o escuro, ele fica sobre um chip
 * claro no tema escuro — sem isso, um logo de traço escuro (o do SomaFlow tem o
 * "Soma" em cinza) some no fundo. Vigiado por `logo-nao-some-no-tema-escuro`.
 *
 * `<img>` em vez de next/image: a URL é de quem hospeda, e o `next/image` exige
 * allowlist de domínios fechada em BUILD — a imagem pré-buildada recusaria o
 * domínio do operador. Altura fixa e largura livre para não distorcer arte de
 * proporção desconhecida. Os `data-testid` são lidos por `tests/e2e/marca-logo.spec.ts`.
 */
function logoDaFachada(marca: MarcaDeSaida, tamanho: string): React.ReactNode {
  if (!marca.logoUrl && !marca.logoDarkUrl) return null;
  return (
    <div
      className={
        marca.logoDarkUrl
          ? "rounded-md"
          : "rounded-md dark:bg-white dark:px-3 dark:py-2 dark:shadow-sm"
      }
    >
      {marca.logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          data-testid="logo-da-fachada"
          src={marca.logoUrl}
          alt={marca.nome}
          className={`${tamanho} w-auto object-contain${marca.logoDarkUrl ? " dark:hidden" : ""}`}
        />
      ) : (
        <span className="dark:hidden">{marca.nome}</span>
      )}
      {marca.logoDarkUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          data-testid="logo-escuro-da-fachada"
          src={marca.logoDarkUrl}
          alt={marca.nome}
          className={`hidden ${tamanho} w-auto object-contain dark:block`}
        />
      ) : null}
    </div>
  );
}

export default async function PublicLayout({ children }: { children: React.ReactNode }) {
  const marca = await marcaDaSaida(null);
  // A maioria destas telas roda ANTES do login (não há usuário nenhum), mas
  // duas — `/login/mfa` e, em parte, `/login/recovery` — rodam com uma sessão
  // parcial já criada (primeiro fator verificado, segundo pendente). Onde há
  // sessão, o idioma salvo no perfil vale; sem ela, `IdiomaProvider` já cai no
  // padrão pt-BR sozinho (ver o cabeçalho do provider) — nunca lança.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const locale = (user?.user_metadata?.locale as string | undefined) ?? null;

  return (
    <IdiomaProvider locale={locale}>
      <div className="relative flex min-h-screen items-center justify-center bg-background p-6 overflow-hidden">
        <div className="absolute inset-0 pointer-events-none overflow-hidden -z-0">
          <ThreeDMarquee className="w-full h-full" />
          {/* Vinheta ultra sutil apenas para foco na logo central sem cobrir os prints */}
          <div
            className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_30%,rgba(0,0,0,0.08)_100%)] dark:bg-[radial-gradient(ellipse_at_center,transparent_30%,rgba(0,0,0,0.4)_100%)]"
            aria-hidden
          />
        </div>
        <PublicAuthShell
          marca={marca}
          logoGrande={logoDaFachada(marca, "h-[85px] md:h-[110px] max-w-[22rem]")}
          logoPequeno={logoDaFachada(marca, "h-[67px] max-w-[20rem]")}
        >
          {children}
        </PublicAuthShell>
      </div>
    </IdiomaProvider>
  );
}
