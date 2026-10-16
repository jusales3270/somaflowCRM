"use client";

/**
 * Decisores das empresas marcadas, pelo Treg — o bloco da lista B2B.
 *
 * A pessoa escolhe os cargos, quantas pessoas por empresa, se quer o celular e o
 * TETO de gasto. A rodada roda em passos: enquanto esta tela está aberta, ela
 * pede o próximo passo (`enrich_step`) e mostra o progresso; se a aba fechar, o
 * cron da prospecção continua de onde parou. O teto é duro — a rodada para
 * sozinha nele, e no saldo zerado do Treg, guardando o que já achou.
 */
import { useEffect, useRef, useState } from "react";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { randomId } from "@/lib/random-id";

export type Rodada = {
  id: string;
  cargos: string[];
  por_empresa: number;
  com_celular: boolean;
  teto_micro: number;
  gasto_micro: number;
  status: "running" | "done" | "stopped_budget" | "no_balance" | "failed" | "cancelled";
  empresas_total: number;
  empresas_feitas: number;
  contatos_achados: number;
  error: string | null;
};

const CARGOS_SUGERIDOS = ["CEO", "Diretor Industrial", "Diretor de Operações", "Gerente de Produção", "Sócio"];

function dolares(micro: number): string {
  return `US$ ${(micro / 1_000_000).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function Decisores({
  buscaId,
  marcadas,
  rodadas,
  tregConfigurado,
  cotacao,
  aoMudar,
}: {
  buscaId: string;
  marcadas: number;
  rodadas: Rodada[];
  tregConfigurado: boolean;
  cotacao: number | null;
  aoMudar: () => Promise<unknown>;
}) {
  const t = useT();
  const [cargos, setCargos] = useState<string[]>(["CEO", "Diretor Industrial"]);
  const [novoCargo, setNovoCargo] = useState("");
  const [porEmpresa, setPorEmpresa] = useState(1);
  const [comCelular, setComCelular] = useState(false);
  const [teto, setTeto] = useState("5");
  const [iniciando, setIniciando] = useState(false);
  // A rodada que este componente já está avançando: marca de laço, não estado de
  // tela (nada redesenha por ela).
  const rodando = useRef<string | null>(null);
  const vivo = useRef(true);
  const aoMudarRef = useRef(aoMudar);
  useEffect(() => {
    aoMudarRef.current = aoMudar;
  }, [aoMudar]);

  const ultima = rodadas[0] ?? null;
  const tetoUsd = Number(teto.replace(",", ".")) || 0;

  useEffect(() => {
    vivo.current = true;
    return () => {
      vivo.current = false;
    };
  }, []);

  // A rodada aberta avança enquanto a tela está aberta (inclusive a que outra
  // aba começou). Um laço por rodada; o servidor processa por ~20 s a cada passo.
  useEffect(() => {
    if (!ultima || ultima.status !== "running" || rodando.current === ultima.id) return;
    const id = ultima.id;
    rodando.current = id;
    void (async () => {
      try {
        while (vivo.current) {
          const r = await apiClient.post<{ data: { rodada: Rodada } }>("/api/v1/prospecting/b2b", {
            action: "enrich_step",
            run_id: id,
          });
          await aoMudarRef.current();
          if (r.data.rodada.status !== "running") break;
        }
      } catch (e) {
        if (vivo.current) showApiError(e);
      } finally {
        rodando.current = null;
      }
    })();
  }, [ultima]);

  async function iniciar() {
    setIniciando(true);
    try {
      await apiClient.post("/api/v1/prospecting/b2b", {
        action: "enrich_start",
        request_id: randomId(),
        search_id: buscaId,
        cargos,
        por_empresa: porEmpresa,
        com_celular: comCelular,
        teto_usd: tetoUsd,
      });
      await aoMudar();
    } catch (e) {
      showApiError(e);
    } finally {
      setIniciando(false);
    }
  }

  async function parar() {
    if (!ultima) return;
    try {
      await apiClient.post("/api/v1/prospecting/b2b", { action: "enrich_cancel", run_id: ultima.id });
      await aoMudar();
    } catch (e) {
      showApiError(e);
    }
  }

  function adicionarCargo(c: string) {
    const limpo = c.trim();
    if (limpo.length < 2 || cargos.length >= 5 || cargos.some((x) => x.toLowerCase() === limpo.toLowerCase())) return;
    setCargos((atual) => [...atual, limpo]);
    setNovoCargo("");
  }

  const emAndamento = ultima?.status === "running";
  const FINAL: Record<Exclude<Rodada["status"], "running">, string> = {
    done: t("Busca de decisores concluída."),
    stopped_budget: t("Parou no teto de gasto. O que já foi achado ficou na lista."),
    no_balance: t("O saldo do Treg acabou. Recarregue e busque de novo: as empresas já feitas não são pagas outra vez."),
    failed: t("A busca de decisores falhou."),
    cancelled: t("Busca de decisores interrompida."),
  };

  return (
    <div className="flex flex-col gap-3 rounded-md border p-3" data-testid="b2b-decisores">
      <div>
        <h3 className="text-sm font-semibold">{t("Decisores (Treg)")}</h3>
        <p className="text-xs text-muted-foreground">
          {t(
            "Acha, na base da Apollo (pelo Treg), quem decide nas empresas marcadas que ainda não têm decisor — dono, sócio, diretoria, gerência — com nome, cargo, LinkedIn e e-mail. A pessoa vem ligada à própria empresa. Cada consulta paga sai da sua conta no Treg; a busca para sozinha no teto.",
          )}
        </p>
      </div>

      {!tregConfigurado ? (
        <p className="text-sm text-muted-foreground">{t("Salve o token do Treg em Fontes, no topo, para buscar decisores.")}</p>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">{t("Cargos procurados (na ordem)")}</span>
            <div className="flex flex-wrap gap-1.5" data-testid="b2b-cargos">
              {cargos.map((c) => (
                <Badge key={c} variant="secondary" className="gap-1">
                  {c}
                  <button
                    type="button"
                    aria-label={t("Remover")}
                    onClick={() => setCargos((atual) => atual.filter((x) => x !== c))}
                  >
                    ×
                  </button>
                </Badge>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id="b2b-cargo"
                className="w-56"
                value={novoCargo}
                placeholder={t("Outro cargo")}
                onChange={(e) => setNovoCargo(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    adicionarCargo(novoCargo);
                  }
                }}
              />
              {CARGOS_SUGERIDOS.filter((c) => !cargos.includes(c)).map((c) => (
                <Button key={c} type="button" variant="outline" size="sm" onClick={() => adicionarCargo(c)}>
                  + {c}
                </Button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="b2b-por-empresa">{t("Pessoas por empresa")}</Label>
              <select
                id="b2b-por-empresa"
                className="h-9 rounded-md border bg-background px-2 text-sm"
                value={porEmpresa}
                onChange={(e) => setPorEmpresa(Number(e.target.value))}
              >
                {[1, 2, 3].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="b2b-teto">{t("Teto de gasto (US$)")}</Label>
              <Input
                id="b2b-teto"
                inputMode="decimal"
                className="w-28"
                value={teto}
                onChange={(e) => setTeto(e.target.value.replace(/[^\d.,]/g, ""))}
              />
            </div>
            {cotacao && tetoUsd > 0 ? (
              <p className="pb-2 text-xs text-muted-foreground" data-testid="b2b-teto-reais">
                ≈ {(tetoUsd * cotacao).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}{" "}
                {t("pela cotação do dólar de hoje")}
              </p>
            ) : null}
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4 accent-[var(--color-accent)]"
              checked={comCelular}
              onChange={(e) => setComCelular(e.target.checked)}
            />
            {t("Buscar também o celular (bem mais caro: até US$ 0,75 por número achado)")}
          </label>
          <p className="text-xs text-muted-foreground">
            {t(
              "Custo: procurar quem decide é grátis; revelar cada decisor (nome completo, LinkedIn e e-mail) custa US$ 0,026; empresa sem site custa mais US$ 0,026 para achá-la pelo nome. Empresa sem ninguém achado não paga revelação.",
            )}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={iniciar}
              disabled={iniciando || emAndamento || !cargos.length || tetoUsd < 0.1 || marcadas === 0}
            >
              {iniciando ? t("Começando...") : `${t("Buscar decisores")} (${marcadas})`}
            </Button>
            {emAndamento ? (
              <Button variant="outline" onClick={parar}>
                {t("Parar")}
              </Button>
            ) : null}
          </div>
        </>
      )}

      {ultima ? (
        <div className="text-sm" role="status" data-testid="b2b-decisores-progresso">
          <span className="tabular-nums">
            {ultima.empresas_feitas} {t("de")} {ultima.empresas_total} {t("empresas")} · {ultima.contatos_achados}{" "}
            {ultima.contatos_achados === 1 ? t("decisor") : t("decisores")} · {dolares(ultima.gasto_micro)} {t("de")}{" "}
            {dolares(ultima.teto_micro)}
          </span>
          {ultima.status === "running" ? (
            <span className="block text-xs text-muted-foreground">{t("Buscando... pode fechar a tela: a busca continua sozinha.")}</span>
          ) : (
            <span className={`block text-xs ${ultima.status === "done" ? "text-muted-foreground" : "text-amber-700 dark:text-amber-400"}`}>
              {FINAL[ultima.status]}
              {ultima.error && ultima.status !== "done" ? ` ${ultima.error}` : ""}
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}
