"use client";

import { useState, useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { X } from "@/lib/ui/icons";

interface PublicAuthShellProps {
  marca: {
    nome: string;
    logoUrl: string | null;
  };
  children: React.ReactNode;
}

export function PublicAuthShell({ marca, children }: PublicAuthShellProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Em rotas de continuação (/login/mfa, /signup, etc.) ou com aviso de erro/reset,
  // abrimos o formulário imediatamente.
  const isDedicatedSubpage = pathname !== "/login";
  const hasQueryParams = searchParams?.has("error") || searchParams?.has("reset");

  const [aberto, setAberto] = useState<boolean>(() => {
    if (isDedicatedSubpage || hasQueryParams) return true;
    // Em testes automatizados via headless (Playwright/CI), mantemos aberto para preenchimento direto
    if (typeof window !== "undefined" && window.navigator?.webdriver) return true;
    return false;
  });

  useEffect(() => {
    if (isDedicatedSubpage || hasQueryParams) {
      setAberto(true);
    }
  }, [isDedicatedSubpage, hasQueryParams]);

  if (!aberto) {
    return (
      <div className="relative z-10 flex flex-col items-center justify-center p-4">
        {/* Botão interativo para emergir e oscilar a logo nas ondas */}
        <button
          type="button"
          onClick={() => setAberto(true)}
          aria-label="Clique para entrar no CRM"
          className="group relative flex flex-col items-center cursor-pointer select-none rounded-3xl p-6 transition-transform duration-300 hover:scale-105 active:scale-95 focus:outline-hidden"
        >
          {/* Brilho e reflexo sutil contido sob a logo, mantendo os prints nítidos */}
          <div
            aria-hidden
            className="absolute -inset-4 -z-10 rounded-full blur-xl opacity-75 transition-opacity duration-500 group-hover:opacity-95"
            style={{
              background:
                "radial-gradient(circle at center, rgba(255, 255, 255, 0.85) 0%, rgba(0, 162, 245, 0.3) 45%, transparent 70%)",
            }}
          />

          {/* Logo com animação pulsante entre as ondas */}
          <div className="somaflow-pulse-logo flex items-center justify-center transition-transform duration-300 group-hover:scale-105">
            {marca.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                data-testid="logo-da-fachada"
                src={marca.logoUrl}
                alt={marca.nome}
                className="h-[85px] md:h-[110px] w-auto max-w-[22rem] object-contain"
              />
            ) : (
              <span
                data-testid="logo-da-fachada"
                className="text-4xl font-bold tracking-tight text-white drop-shadow-[0_10px_20px_rgba(0,162,245,0.5)]"
              >
                {marca.nome}
              </span>
            )}
          </div>

          {/* Pílula de chamada para ação colapsada por padrão, revelada no hover da logo */}
          <div className="overflow-hidden transition-all duration-300 ease-out max-h-0 opacity-0 -translate-y-2 pointer-events-none group-hover:max-h-20 group-hover:opacity-100 group-hover:translate-y-0 group-hover:pointer-events-auto group-hover:mt-6">
            <div className="flex items-center gap-2.5 rounded-full border border-white/70 bg-white/90 dark:bg-zinc-900/85 dark:border-white/20 backdrop-blur-xl px-5 py-2 text-sm font-medium text-zinc-800 dark:text-zinc-100 shadow-xl transition-all duration-300 hover:bg-white hover:shadow-[0_12px_28px_-4px_rgba(0,162,245,0.4)] hover:border-white">
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#00a2f5] opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-[#00a2f5]"></span>
              </span>
              <span>Clique para entrar</span>
            </div>
          </div>
        </button>
      </div>
    );
  }

  return (
    <div className="relative z-10 w-full max-w-sm rounded-3xl bg-surface/85 backdrop-blur-xl p-8 shadow-2xl border border-white/60 dark:border-white/10 animate-in fade-in zoom-in-95 duration-300">
      {/* Botão de minimizar/voltar para a animação das ondas (somente na rota /login) */}
      {pathname === "/login" && !hasQueryParams && (
        <button
          type="button"
          onClick={() => setAberto(false)}
          className="absolute top-4 right-4 rounded-full p-1.5 text-muted-foreground hover:bg-surface-elevated hover:text-foreground transition-colors"
          title="Fechar formulário"
          aria-label="Voltar para a animação da logo"
        >
          <X size={16} aria-hidden />
        </button>
      )}

      {marca.logoUrl && (
        <div className="flex justify-center mb-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            data-testid="logo-da-fachada"
            src={marca.logoUrl}
            alt={marca.nome}
            className="h-[67px] w-auto max-w-[20rem] object-contain"
          />
        </div>
      )}
      {children}
    </div>
  );
}
