import Link from "next/link";
import { redirect } from "next/navigation";

import { buttonVariants } from "@/components/ui/button";
import { ThreeDMarquee } from "@/components/ui/three-d-marquee";
import { marcaDaSaida } from "@/lib/branding/saida";
import type { MarcaDeSaida } from "@/lib/branding/saida";
import { idiomaDoVisitante } from "@/lib/i18n/idiomaAnonimo";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

/**
 * A página inicial pública.
 *
 * Quem tem sessão segue direto para o painel, como sempre foi. Quem não tem vê
 * uma página que diz o que o produto é e leva à política de privacidade e aos
 * termos — sem pedir login. A verificação de um app que pede dados de conta
 * Google exige exatamente isso: o revisor abre o endereço principal sem entrar e
 * precisa ver o nome do produto, o que ele faz e o link da política.
 *
 * `/` já é caminho público no `proxy` (`lib/auth/public-paths.ts`), então nada
 * lá muda. O nome vem da marca resolvida (`marcaDaSaida`: banco acima do
 * `.env`), nunca de texto fixo: uma imagem serve todas as marcas.
 *
 * SomaFlow: o visual é o da tela de entrada — o fundo com as telas do CRM
 * (`ThreeDMarquee`), o logo da marca em destaque e o botão de entrar na cor da
 * marca (`bg-accent`, que a marca da revenda repinta). O logo é o da marca em
 * vigor: o do revendedor, quando ele tem um; sem logo, o nome em texto.
 *
 * `getUser()` e nunca `getSession()`: o redirecionamento só vale para sessão que
 * o servidor de autenticação confirmou.
 */
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) redirect("/app");

  const marca = await marcaDaSaida(null);
  const idioma = await idiomaDoVisitante(null);
  const t = (texto: string) => traduzir(texto, idioma);

  const recursos = [
    {
      titulo: t("Conversas no WhatsApp"),
      texto: t(
        "As conversas da equipe num só lugar, com fila, responsável e o histórico de cada cliente.",
      ),
    },
    {
      titulo: t("Funil e agenda"),
      texto: t("O funil de vendas e a agenda de atendimentos andando junto com as conversas."),
    },
    {
      titulo: t("Agentes de inteligência artificial"),
      texto: t(
        "Respondem, qualificam o interesse e passam a conversa para uma pessoa quando é preciso.",
      ),
    },
  ];

  return (
    <div className="relative min-h-screen overflow-hidden bg-background text-text">
      {/* O fundo da tela de entrada, esmaecido para baixo: decoração, não conteúdo. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[38rem] overflow-hidden opacity-50 [mask-image:linear-gradient(to_bottom,black_35%,transparent)] dark:opacity-30"
      >
        <ThreeDMarquee className="h-full w-full" />
      </div>

      <header className="relative z-10">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-6 py-5">
          <Logo marca={marca} classe="max-h-9 max-w-[10rem]" />
          <Link href="/login" className={buttonVariants({ variant: "primary" })}>
            {t("Entrar")}
          </Link>
        </div>
      </header>

      <main className="relative z-10">
        <section className="mx-auto flex w-full max-w-3xl flex-col items-center px-6 pb-16 pt-10 text-center md:pt-16">
          <div className="rounded-3xl bg-surface/80 px-8 py-7 shadow-2xl backdrop-blur-xl">
            <div className="somaflow-pulse-logo flex justify-center">
              <Logo marca={marca} classe="max-h-24 max-w-[min(20rem,100%)]" grande />
            </div>
          </div>
          <h1 className="mt-8 text-3xl font-semibold tracking-tight md:text-4xl">{marca.nome}</h1>
          <p className="mt-3 max-w-xl text-lg text-text-muted">
            {t("Atendimento e vendas pelo WhatsApp, com agentes de inteligência artificial.")}
          </p>
          <Link
            href="/login"
            className={cn(buttonVariants({ variant: "primary", size: "lg" }), "mt-8 shadow-lg")}
          >
            {t("Entrar")}
          </Link>
        </section>

        <section className="mx-auto grid w-full max-w-5xl gap-4 px-6 md:grid-cols-3">
          {recursos.map((r) => (
            <div key={r.titulo} className="rounded-2xl border border-border bg-surface p-5 shadow-xs">
              <h2 className="text-base font-semibold tracking-tight">{r.titulo}</h2>
              <p className="mt-1.5 text-sm leading-relaxed text-text-muted">{r.texto}</p>
            </div>
          ))}
        </section>

        <section className="mx-auto w-full max-w-3xl space-y-5 px-6 py-14 leading-relaxed">
          <p>
            {t("O")} {marca.nome}{" "}
            {t(
              "reúne em um só lugar as conversas com os clientes, o funil de vendas, a agenda de atendimentos e agentes de inteligência artificial que respondem, qualificam o interesse e passam a conversa para uma pessoa quando é preciso.",
            )}
          </p>
          <p>
            {t("Quando a empresa conecta o Google Agenda, o")} {marca.nome}{" "}
            {t(
              "mostra a ocupação da agenda e cria, altera e cancela os agendamentos pedidos pela própria pessoa. Quando conecta o Google Ads, devolve ao anúncio as vendas que ele trouxe. O uso dos dados do Google está descrito na",
            )}{" "}
            <Link href="/legal/privacy#dados-do-google" className="underline underline-offset-2">
              {t("Política de Privacidade")}
            </Link>
            .
          </p>
        </section>
      </main>

      <footer className="relative z-10 border-t border-border bg-surface">
        <nav className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-5 text-sm">
          <span className="font-medium">{marca.nome}</span>
          <Link href="/legal/privacy" className="underline underline-offset-2">
            {t("Política de Privacidade")}
          </Link>
          <Link href="/legal/terms" className="underline underline-offset-2">
            {t("Termos de Uso")}
          </Link>
        </nav>
      </footer>
    </div>
  );
}

/**
 * O logo da marca em vigor, com a arte do tema escuro quando houver. `<img>` e
 * não `next/image`: a URL é de quem hospeda, fora da allowlist fechada no build
 * da imagem pré-buildada (mesmo motivo de `app/(public)/layout.tsx`). Teto de
 * altura e largura, nunca tamanho fixo: arte pequena não é ampliada.
 */
function Logo({ marca, classe, grande }: { marca: MarcaDeSaida; classe: string; grande?: boolean }) {
  if (!marca.logoUrl && !marca.logoDarkUrl) {
    return (
      <span className={cn("font-semibold tracking-tight", grande ? "text-3xl" : "text-base")}>
        {marca.nome}
      </span>
    );
  }
  return (
    <>
      {marca.logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={marca.logoUrl}
          alt={marca.nome}
          className={cn("h-auto w-auto object-contain", classe, marca.logoDarkUrl && "dark:hidden")}
        />
      ) : (
        <span className="font-semibold tracking-tight dark:hidden">{marca.nome}</span>
      )}
      {marca.logoDarkUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={marca.logoDarkUrl}
          alt={marca.nome}
          className={cn("hidden h-auto w-auto object-contain dark:block", classe)}
        />
      ) : null}
    </>
  );
}
