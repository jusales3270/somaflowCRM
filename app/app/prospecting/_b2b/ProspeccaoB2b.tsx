"use client";

/**
 * Prospecção B2B por CNPJ — a tela.
 *
 * Três passos: (1) a chave da CNPJá, (2) o perfil das empresas (descrição → CNAEs
 * sugeridos; estados e cidades; faturamento pelo porte da Receita) e (3) a lista,
 * com seleção e exportação em CSV. Não envia mensagem a ninguém: a lista sai por
 * exportação, e quem aborda decide como.
 *
 * O motor do Google Maps continua em `../_client.tsx`, intacto; o seletor de nível
 * mora em `../page.tsx`.
 */
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { randomId } from "@/lib/random-id";
import type { EmpresaB2b } from "@/lib/prospecting/b2b/schema";

const UFS = [
  "AC", "AL", "AM", "AP", "BA", "CE", "DF", "ES", "GO", "MA", "MG", "MS", "MT", "PA",
  "PB", "PE", "PI", "PR", "RJ", "RN", "RO", "RR", "RS", "SC", "SE", "SP", "TO",
];

type Credencial = { provider: "cnpja" | "treg"; configurada: boolean; last4: string | null; verificada_em: string | null };
type Busca = {
  id: string;
  name: string;
  status: "running" | "done" | "partial" | "failed";
  tem_mais: boolean;
  credits_used: number;
  results_count: number;
  total_available: number | null;
  error: string | null;
  created_at: string;
};
type Empresa = { id: string; cnpj: string; data: EmpresaB2b; selected: boolean; score_band: string | null };
type Estado = { credenciais: Credencial[]; buscas: Busca[]; empresas: Empresa[] };
type Cnae = { codigo: string; descricao: string; motivo?: string | null };
type Cidade = { codigo: number; nome: string; uf: string };

function formatarCnpj(c: string): string {
  return c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
}
function formatarReais(v: number | null): string {
  return v === null ? "—" : v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
}
function formatarTelefone(n: string): string {
  return n.replace(/^(\d{2})(\d{4,5})(\d{4})$/, "($1) $2-$3");
}

export function ProspeccaoB2b() {
  const t = useT();
  const queryClient = useQueryClient();
  const [buscaAtual, setBuscaAtual] = useState<string | null>(null);
  const estado = useQuery({
    queryKey: ["prospecting-b2b", buscaAtual],
    queryFn: async () =>
      (await apiClient.get<{ data: Estado }>(
        `/api/v1/prospecting/b2b${buscaAtual ? `?search=${buscaAtual}` : ""}`,
      )).data,
  });
  const recarregar = () => queryClient.invalidateQueries({ queryKey: ["prospecting-b2b"] });

  // ── 1. chave ─────────────────────────────────────────────────────────────
  const cnpja = estado.data?.credenciais.find((c) => c.provider === "cnpja");
  const [chave, setChave] = useState("");
  const [saldo, setSaldo] = useState<string | null>(null);
  const [salvandoChave, setSalvandoChave] = useState(false);
  async function salvarChave() {
    setSalvandoChave(true);
    try {
      const r = await apiClient.post<{ data: { detalhe: string } }>("/api/v1/prospecting/b2b", {
        action: "configure_credential",
        provider: "cnpja",
        api_key: chave,
      });
      setSaldo(r.data.detalhe);
      setChave("");
      await recarregar();
    } catch (e) {
      showApiError(e);
    } finally {
      setSalvandoChave(false);
    }
  }
  async function testarChave({ calado = false }: { calado?: boolean } = {}) {
    try {
      const r = await apiClient.post<{ data: { detalhe: string } }>("/api/v1/prospecting/b2b", {
        action: "test_credential",
        provider: "cnpja",
      });
      setSaldo(r.data.detalhe);
    } catch (e) {
      // Depois de uma busca, o saldo é só informação: se a consulta falhar, a
      // busca já deu certo e não há o que avisar.
      if (!calado) showApiError(e);
    }
  }

  // ── 2. perfil ────────────────────────────────────────────────────────────
  const [nome, setNome] = useState("");
  const [descricao, setDescricao] = useState("");
  const [sugeridos, setSugeridos] = useState<Cnae[]>([]);
  const [origemSugestao, setOrigemSugestao] = useState<"ia" | "palavras" | null>(null);
  const [sugerindo, setSugerindo] = useState(false);
  const [cnaes, setCnaes] = useState<Cnae[]>([]);
  const [buscaCnae, setBuscaCnae] = useState("");
  const [achadosCnae, setAchadosCnae] = useState<Cnae[]>([]);
  const [soPrincipal, setSoPrincipal] = useState(true);
  const [ufs, setUfs] = useState<string[]>([]);
  const [buscaCidade, setBuscaCidade] = useState("");
  const [achadasCidades, setAchadasCidades] = useState<Cidade[]>([]);
  const [cidades, setCidades] = useState<Cidade[]>([]);
  const [portes, setPortes] = useState<number[]>([5]);
  const [naoSimples, setNaoSimples] = useState(false);
  const [capitalMinimo, setCapitalMinimo] = useState("");
  const [soMatriz, setSoMatriz] = useState(true);
  const [exigeTelefone, setExigeTelefone] = useState(false);
  const [exigeEmail, setExigeEmail] = useState(false);
  const [maximo, setMaximo] = useState(100);
  const [buscando, setBuscando] = useState(false);

  async function sugerir() {
    setSugerindo(true);
    try {
      const r = await apiClient.post<{ data: { sugeridos: Cnae[]; origem: "ia" | "palavras" } }>(
        "/api/v1/prospecting/b2b",
        { action: "suggest_cnae", descricao },
      );
      setSugeridos(r.data.sugeridos);
      setOrigemSugestao(r.data.origem);
    } catch (e) {
      showApiError(e);
    } finally {
      setSugerindo(false);
    }
  }
  async function procurarCnae(q: string) {
    setBuscaCnae(q);
    if (q.trim().length < 3) return setAchadosCnae([]);
    try {
      const r = await apiClient.get<{ data: { itens: Cnae[] } }>(
        `/api/v1/prospecting/b2b/catalogos?tipo=cnae&q=${encodeURIComponent(q)}`,
      );
      setAchadosCnae(r.data.itens);
    } catch (e) {
      showApiError(e);
    }
  }
  async function procurarCidade(q: string) {
    setBuscaCidade(q);
    if (q.trim().length < 2) return setAchadasCidades([]);
    try {
      const r = await apiClient.get<{ data: { itens: Cidade[] } }>(
        `/api/v1/prospecting/b2b/catalogos?tipo=municipio&q=${encodeURIComponent(q)}&ufs=${ufs.join(",")}`,
      );
      setAchadasCidades(r.data.itens);
    } catch (e) {
      showApiError(e);
    }
  }
  const alternarCnae = (c: Cnae) =>
    setCnaes((atual) => (atual.some((x) => x.codigo === c.codigo) ? atual.filter((x) => x.codigo !== c.codigo) : [...atual, c]));
  const alternarUf = (uf: string) => {
    setUfs((atual) => (atual.includes(uf) ? atual.filter((u) => u !== uf) : [...atual, uf]));
    // Cidade de estado que saiu da seleção deixa de valer.
    setCidades((atual) => atual.filter((c) => c.uf !== uf || !ufs.includes(uf)));
  };
  const alternarPorte = (p: number) =>
    setPortes((atual) => (atual.includes(p) ? atual.filter((x) => x !== p) : [...atual, p]));

  const podeBuscar =
    !!cnpja?.configurada && nome.trim() && cnaes.length > 0 && (ufs.length > 0 || cidades.length > 0) && portes.length > 0;
  const creditos = Math.ceil(maximo / 10);

  async function buscar() {
    setBuscando(true);
    try {
      const r = await apiClient.post<{ data: { busca: Busca } }>("/api/v1/prospecting/b2b", {
        action: "search",
        request_id: randomId(),
        name: nome.trim(),
        filtros: {
          descricao,
          cnaes: cnaes.map((c) => c.codigo),
          tipo_cnae: soPrincipal ? "principal" : "qualquer",
          ufs,
          municipios: cidades.map((c) => c.codigo),
          portes,
          so_ativas: true,
          so_matriz: soMatriz,
          nao_optante_simples: naoSimples,
          capital_minimo: capitalMinimo ? Number(capitalMinimo.replace(/\D/g, "")) : null,
          exige_telefone: exigeTelefone,
          exige_email: exigeEmail,
          max_resultados: maximo,
        },
      });
      setBuscaAtual(r.data.busca.id);
      await recarregar();
      void testarChave({ calado: true });
    } catch (e) {
      showApiError(e);
    } finally {
      setBuscando(false);
    }
  }

  // ── 3. resultados ────────────────────────────────────────────────────────
  const busca = estado.data?.buscas.find((b) => b.id === buscaAtual) ?? null;
  const empresas = useMemo(() => estado.data?.empresas ?? [], [estado.data]);
  const selecionadas = empresas.filter((e) => e.selected).length;
  async function selecionar(ids: string[], selected: boolean) {
    if (!busca || !ids.length) return;
    // Otimista: a caixa muda no clique. Se o servidor recusar, a lista volta ao
    // que está gravado e o erro aparece.
    const alvo = new Set(ids);
    queryClient.setQueryData<Estado>(["prospecting-b2b", buscaAtual], (antes) =>
      antes
        ? { ...antes, empresas: antes.empresas.map((e) => (alvo.has(e.id) ? { ...e, selected } : e)) }
        : antes,
    );
    try {
      await apiClient.post("/api/v1/prospecting/b2b", { action: "select", id: busca.id, selected, company_ids: ids });
    } catch (e) {
      showApiError(e);
      await recarregar();
    }
  }
  async function carregarMais() {
    if (!busca) return;
    setBuscando(true);
    try {
      await apiClient.post("/api/v1/prospecting/b2b", { action: "load_more", id: busca.id });
      await recarregar();
      // A busca gastou créditos: o saldo mostrado acima não pode ficar no de antes.
      void testarChave({ calado: true });
    } catch (e) {
      showApiError(e);
    } finally {
      setBuscando(false);
    }
  }

  const caixa = "h-4 w-4 accent-[var(--color-accent)]";

  return (
    <div className="flex flex-col gap-6" data-testid="prospeccao-b2b">
      <Card className="p-4">
        <h2 className="text-base font-semibold tracking-tight">{t("Fonte: CNPJá")}</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {t(
            "A busca usa a base de CNPJs da Receita pela CNPJá. Cada 10 empresas encontradas custam 1 crédito da sua conta lá.",
          )}
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="flex min-w-[16rem] flex-1 flex-col gap-1.5">
            <Label htmlFor="b2b-chave">
              {t("Chave da API")}{" "}
              {cnpja?.configurada ? (
                <span className="text-muted-foreground">
                  ({t("configurada, termina em")} {cnpja.last4})
                </span>
              ) : null}
            </Label>
            <Input
              id="b2b-chave"
              type="password"
              value={chave}
              placeholder={cnpja?.configurada ? t("Deixe em branco para manter a atual") : ""}
              onChange={(e) => setChave(e.target.value)}
            />
          </div>
          <Button onClick={salvarChave} disabled={salvandoChave || chave.trim().length < 8}>
            {salvandoChave ? t("Salvando...") : t("Salvar")}
          </Button>
          {cnpja?.configurada ? (
            <Button variant="outline" onClick={() => void testarChave()}>
              {t("Testar")}
            </Button>
          ) : null}
        </div>
        {saldo ? (
          <p className="mt-2 text-sm text-muted-foreground" role="status" data-testid="b2b-saldo">
            {saldo}
          </p>
        ) : null}
      </Card>

      <Card className="p-4">
        <h2 className="text-base font-semibold tracking-tight">{t("1. Perfil das empresas")}</h2>

        <div className="mt-3 flex flex-col gap-1.5">
          <Label htmlFor="b2b-nome">{t("Nome da busca")}</Label>
          <Input id="b2b-nome" value={nome} maxLength={120} onChange={(e) => setNome(e.target.value)} />
        </div>

        <div className="mt-4 flex flex-col gap-1.5">
          <Label htmlFor="b2b-descricao">{t("Descreva o tipo de empresa")}</Label>
          <Textarea
            id="b2b-descricao"
            value={descricao}
            maxLength={500}
            rows={3}
            placeholder={t("Ex.: indústrias de alimentos e bebidas de médio porte que vendem para redes de varejo")}
            onChange={(e) => setDescricao(e.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={sugerir} disabled={sugerindo || descricao.trim().length < 3}>
              {sugerindo ? t("Sugerindo...") : t("Sugerir CNAEs")}
            </Button>
            {origemSugestao === "palavras" ? (
              <span className="text-xs text-muted-foreground">
                {t("Sugestões pela busca de palavras (sem IA configurada ou indisponível).")}
              </span>
            ) : null}
          </div>
          {sugeridos.length ? (
            <ul className="mt-1 flex flex-col gap-1" data-testid="b2b-sugeridos">
              {sugeridos.map((c) => (
                <li key={c.codigo}>
                  <label className="flex cursor-pointer items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className={`${caixa} mt-0.5`}
                      checked={cnaes.some((x) => x.codigo === c.codigo)}
                      onChange={() => alternarCnae(c)}
                    />
                    <span>
                      <span className="font-mono text-xs">{c.codigo}</span> — {c.descricao}
                      {c.motivo ? <span className="block text-xs text-muted-foreground">{c.motivo}</span> : null}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="mt-4 flex flex-col gap-1.5">
          <Label htmlFor="b2b-cnae-catalogo">{t("Ou procure no catálogo de CNAE")}</Label>
          <Input
            id="b2b-cnae-catalogo"
            value={buscaCnae}
            placeholder={t("Código ou palavras da atividade")}
            onChange={(e) => void procurarCnae(e.target.value)}
          />
          {achadosCnae.length ? (
            <ul className="max-h-48 overflow-y-auto rounded-md border p-1 text-sm">
              {achadosCnae.map((c) => (
                <li key={c.codigo}>
                  <button
                    type="button"
                    className="w-full rounded-md px-2 py-1 text-left hover:bg-muted"
                    onClick={() => {
                      if (!cnaes.some((x) => x.codigo === c.codigo)) alternarCnae(c);
                    }}
                  >
                    <span className="font-mono text-xs">{c.codigo}</span> — {c.descricao}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {cnaes.length ? (
            <div className="flex flex-wrap gap-1.5" data-testid="b2b-cnaes-escolhidos">
              {cnaes.map((c) => (
                <Badge key={c.codigo} variant="secondary" className="gap-1">
                  <span className="font-mono">{c.codigo}</span>
                  <button type="button" aria-label={t("Remover")} onClick={() => alternarCnae(c)}>
                    ×
                  </button>
                </Badge>
              ))}
            </div>
          ) : null}
          <label className="mt-1 flex items-center gap-2 text-sm">
            <input type="checkbox" className={caixa} checked={soPrincipal} onChange={(e) => setSoPrincipal(e.target.checked)} />
            {t("Só a atividade principal da empresa (desmarque para incluir atividades secundárias)")}
          </label>
        </div>

        <div className="mt-4 flex flex-col gap-1.5">
          <span className="text-sm font-medium">{t("Estados")}</span>
          <div className="flex flex-wrap gap-1.5" data-testid="b2b-ufs">
            {UFS.map((uf) => (
              <button
                key={uf}
                type="button"
                aria-pressed={ufs.includes(uf)}
                onClick={() => alternarUf(uf)}
                className={`rounded-md border px-2 py-1 text-xs font-medium ${
                  ufs.includes(uf) ? "border-accent bg-accent text-accent-foreground" : "hover:bg-muted"
                }`}
              >
                {uf}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-1.5">
          <Label htmlFor="b2b-cidade">{t("Cidades (opcional — sem cidade, busca nos estados inteiros)")}</Label>
          <Input
            id="b2b-cidade"
            value={buscaCidade}
            placeholder={t("Nome da cidade")}
            onChange={(e) => void procurarCidade(e.target.value)}
          />
          {achadasCidades.length ? (
            <ul className="max-h-40 overflow-y-auto rounded-md border p-1 text-sm">
              {achadasCidades.map((c) => (
                <li key={c.codigo}>
                  <button
                    type="button"
                    className="w-full rounded-md px-2 py-1 text-left hover:bg-muted"
                    onClick={() => {
                      setCidades((atual) => (atual.some((x) => x.codigo === c.codigo) ? atual : [...atual, c]));
                      if (!ufs.includes(c.uf)) setUfs((atual) => [...atual, c.uf]);
                      setBuscaCidade("");
                      setAchadasCidades([]);
                    }}
                  >
                    {c.nome}/{c.uf}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {cidades.length ? (
            <div className="flex flex-wrap gap-1.5" data-testid="b2b-cidades">
              {cidades.map((c) => (
                <Badge key={c.codigo} variant="secondary" className="gap-1">
                  {c.nome}/{c.uf}
                  <button
                    type="button"
                    aria-label={t("Remover")}
                    onClick={() => setCidades((atual) => atual.filter((x) => x.codigo !== c.codigo))}
                  >
                    ×
                  </button>
                </Badge>
              ))}
            </div>
          ) : null}
        </div>

        <fieldset className="mt-4 flex flex-col gap-1.5">
          <legend className="text-sm font-medium">{t("Faturamento (porte na Receita Federal)")}</legend>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className={caixa} checked={portes.includes(5)} onChange={() => alternarPorte(5)} />
            {t("Acima de R$ 4,8 milhões por ano (porte Demais)")}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className={caixa} checked={portes.includes(3)} onChange={() => alternarPorte(3)} />
            {t("De R$ 360 mil a R$ 4,8 milhões por ano (EPP)")}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className={caixa} checked={portes.includes(1)} onChange={() => alternarPorte(1)} />
            {t("Até R$ 360 mil por ano (ME)")}
          </label>
          <p className="text-xs text-muted-foreground">
            {t(
              "O faturamento de empresa privada não é público: o porte é a faixa oficial declarada à Receita. Os filtros abaixo ajudam a apertar.",
            )}
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className={caixa} checked={naoSimples} onChange={(e) => setNaoSimples(e.target.checked)} />
            {t("Só empresas fora do Simples Nacional")}
          </label>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Label htmlFor="b2b-capital">{t("Capital social mínimo (R$)")}</Label>
            <Input
              id="b2b-capital"
              inputMode="numeric"
              className="w-40"
              value={capitalMinimo}
              onChange={(e) => setCapitalMinimo(e.target.value.replace(/\D/g, ""))}
            />
          </div>
        </fieldset>

        <fieldset className="mt-4 flex flex-col gap-1.5">
          <legend className="text-sm font-medium">{t("Outros filtros")}</legend>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className={caixa} checked={soMatriz} onChange={(e) => setSoMatriz(e.target.checked)} />
            {t("Só a matriz (sem filiais)")}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className={caixa} checked={exigeTelefone} onChange={(e) => setExigeTelefone(e.target.checked)} />
            {t("Só empresas com telefone cadastrado")}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className={caixa} checked={exigeEmail} onChange={(e) => setExigeEmail(e.target.checked)} />
            {t("Só empresas com e-mail cadastrado")}
          </label>
        </fieldset>

        <div className="mt-4 flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="b2b-maximo">{t("Quantas empresas buscar")}</Label>
            <Input
              id="b2b-maximo"
              type="number"
              min={10}
              max={1000}
              step={10}
              className="w-32"
              value={maximo}
              onChange={(e) => setMaximo(Math.min(1000, Math.max(10, Number(e.target.value) || 10)))}
            />
          </div>
          <p className="text-sm text-muted-foreground" data-testid="b2b-custo">
            {t("Custo máximo:")} {creditos} {creditos === 1 ? t("crédito da CNPJá") : t("créditos da CNPJá")}
          </p>
          <Button onClick={buscar} disabled={!podeBuscar || buscando}>
            {buscando ? t("Buscando...") : t("Buscar empresas")}
          </Button>
        </div>
        {!cnpja?.configurada ? (
          <p className="mt-2 text-sm text-muted-foreground">{t("Salve a chave da CNPJá para buscar.")}</p>
        ) : null}
      </Card>

      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold tracking-tight">{t("2. Empresas encontradas")}</h2>
          {estado.data?.buscas.length ? (
            <select
              aria-label={t("Busca")}
              className="rounded-md border bg-background px-2 py-1 text-sm"
              value={buscaAtual ?? ""}
              onChange={(e) => setBuscaAtual(e.target.value || null)}
            >
              <option value="">{t("Escolha uma busca")}</option>
              {estado.data.buscas.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} — {b.results_count} {t("empresas")}
                </option>
              ))}
            </select>
          ) : null}
        </div>

        {busca ? (
          <div className="mt-3 flex flex-col gap-3">
            <p className="text-sm text-muted-foreground" data-testid="b2b-resumo">
              {busca.results_count} {t("empresas")}
              {busca.total_available !== null ? ` ${t("de")} ${busca.total_available.toLocaleString("pt-BR")} ${t("disponíveis")}` : ""}
              {" · "}
              {busca.credits_used} {t("créditos usados")}
              {busca.error ? <span className="block text-destructive">{busca.error}</span> : null}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => selecionar(empresas.filter((e) => !e.selected).map((e) => e.id), true)}>
                {t("Marcar todas")}
              </Button>
              <Button variant="outline" size="sm" onClick={() => selecionar(empresas.filter((e) => e.selected).map((e) => e.id), false)}>
                {t("Desmarcar todas")}
              </Button>
              {busca.tem_mais ? (
                <Button variant="outline" size="sm" onClick={carregarMais} disabled={buscando}>
                  {t("Carregar mais")}
                </Button>
              ) : null}
              <a
                className="inline-flex h-11 items-center rounded-xl bg-accent px-4 text-sm font-medium text-accent-foreground hover:bg-accent-hover lg:h-9"
                href={`/api/v1/prospecting/b2b/exportar?search=${busca.id}`}
                data-testid="b2b-exportar"
              >
                {t("Exportar CSV")} ({selecionadas})
              </a>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[56rem] text-left text-sm" data-testid="b2b-tabela">
                <thead className="text-xs text-muted-foreground">
                  <tr className="border-b">
                    <th className="py-2 pr-2" />
                    <th className="py-2 pr-3 font-medium">{t("Empresa")}</th>
                    <th className="py-2 pr-3 font-medium">{t("Atividade")}</th>
                    <th className="py-2 pr-3 font-medium">{t("Porte")}</th>
                    <th className="py-2 pr-3 text-right font-medium">{t("Capital social")}</th>
                    <th className="py-2 pr-3 font-medium">{t("Cidade")}</th>
                    <th className="py-2 font-medium">{t("Contato")}</th>
                  </tr>
                </thead>
                <tbody>
                  {empresas.map(({ id, data: e, selected }) => (
                    <tr key={id} className="border-b align-top last:border-0">
                      <td className="py-2 pr-2">
                        <input
                          type="checkbox"
                          className={caixa}
                          aria-label={e.razao_social}
                          checked={selected}
                          onChange={() => selecionar([id], !selected)}
                        />
                      </td>
                      <td className="py-2 pr-3">
                        <span className="font-medium">{e.nome_fantasia || e.razao_social}</span>
                        <span className="block text-xs text-muted-foreground">
                          {e.nome_fantasia ? `${e.razao_social} · ` : ""}
                          {formatarCnpj(e.cnpj)}
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-xs">{e.cnae_principal_descricao ?? e.cnae_principal ?? "—"}</td>
                      <td className="py-2 pr-3 text-xs">{e.porte ?? "—"}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{formatarReais(e.capital_social)}</td>
                      <td className="py-2 pr-3 text-xs">{e.cidade ? `${e.cidade}/${e.uf ?? ""}` : "—"}</td>
                      <td className="py-2 text-xs">
                        {e.telefones.slice(0, 2).map((tel) => (
                          <span key={tel.numero} className="block tabular-nums">
                            {formatarTelefone(tel.numero)}
                          </span>
                        ))}
                        {e.emails.slice(0, 1).map((m) => (
                          <span key={m} className="block">
                            {m}
                          </span>
                        ))}
                        {!e.telefones.length && !e.emails.length ? "—" : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            {t("Faça uma busca ou escolha uma das anteriores para ver as empresas.")}
          </p>
        )}
      </Card>
    </div>
  );
}
