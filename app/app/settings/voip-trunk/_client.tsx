"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

export interface TrunkSettingsRow {
  organization_id: string;
  host: string;
  port: number;
  username: string;
  password_last4: string;
  from_domain: string | null;
  endpoint_name: string;
  is_active: boolean;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

type MotivoDaAplicacao = "sem_telefonia" | "asterisk_inacessivel" | "recusado_pelo_asterisk";
type Aplicacao = { ok: true } | { ok: false; motivo: MotivoDaAplicacao; detalhe?: string };

type EstadoDoTronco =
  | "nao_cadastrado"
  | "sem_telefonia"
  | "asterisk_fora"
  | "desativado"
  | "nao_aplicado"
  | "conectado"
  | "recusado"
  | "conectando"
  | "sem_resposta"
  | "provedor_responde";

const queryKey = ["voip", "trunk"] as const;
const statusKey = ["voip", "trunk", "status"] as const;

/**
 * O que cada estado diz para quem opera, e o tom do indicador. A mensagem diz o
 * PRÓXIMO PASSO, não só o que houve: "recusou" sem "confira a senha" deixa a
 * pessoa sem saber o que fazer.
 */
type Tom = "ok" | "atencao" | "erro" | "neutro";

function textosDosEstados(
  t: (texto: string) => string,
): Record<EstadoDoTronco, { tom: Tom; titulo: string; texto: string }> {
  return {
    conectado: {
      tom: "ok",
      titulo: t("Conectado"),
      texto: t("O provedor aceitou o login. As ligações podem entrar e sair por este tronco."),
    },
    conectando: {
      tom: "atencao",
      titulo: t("Conectando"),
      texto: t(
        "O provedor respondeu e o login está em andamento. Verifique de novo em alguns segundos.",
      ),
    },
    recusado: {
      tom: "erro",
      titulo: t("O provedor recusou o login"),
      texto: t("Confira com o provedor o usuário e a senha, corrija aqui e salve de novo."),
    },
    sem_resposta: {
      tom: "erro",
      titulo: t("O provedor não responde"),
      texto: t(
        "Confira o host e a porta. Se estiverem certos, o firewall da VPS precisa liberar a porta UDP 5060 e a faixa 10000–10200.",
      ),
    },
    provedor_responde: {
      tom: "atencao",
      titulo: t("O provedor responde"),
      texto: t(
        "Não deu para confirmar se o login foi aceito: o servidor de telefonia desta instalação é de uma versão anterior. Atualize a instalação para ver o estado completo.",
      ),
    },
    nao_aplicado: {
      tom: "atencao",
      titulo: t("Salvo, ainda não aplicado"),
      texto: t(
        "O tronco está salvo, mas ainda não chegou ao servidor de telefonia. Ele é aplicado automaticamente em até 10 minutos — ou salve de novo.",
      ),
    },
    desativado: {
      tom: "neutro",
      titulo: t("Desativado"),
      texto: t("Nenhuma ligação entra nem sai por este tronco."),
    },
    asterisk_fora: {
      tom: "erro",
      titulo: t("O servidor de telefonia não respondeu"),
      texto: t(
        "Ele pode estar reiniciando. Se continuar assim, quem administra o servidor deve conferir o contêiner do Asterisk.",
      ),
    },
    sem_telefonia: {
      tom: "neutro",
      titulo: t("Telefonia desligada nesta instalação"),
      texto: t(
        "Quem administra o servidor liga o módulo de telefonia. O tronco fica guardado e entra no ar sozinho quando ela for ligada.",
      ),
    },
    nao_cadastrado: {
      tom: "neutro",
      titulo: t("Nenhum tronco cadastrado"),
      texto: t("Preencha os dados do seu provedor SIP abaixo e salve."),
    },
  };
}

const COR_DO_TOM = {
  ok: "bg-emerald-500",
  atencao: "bg-amber-500",
  erro: "bg-red-500",
  neutro: "bg-zinc-400",
} as const;

function useStatusDoTronco() {
  return useQuery({
    queryKey: statusKey,
    queryFn: async () => {
      const res = await apiClient.get<{ data: { estado: EstadoDoTronco; verificado_em: string } }>(
        "/api/v1/voip/trunk/status",
      );
      return res.data;
    },
    // Enquanto conecta, o estado muda em segundos: confere de novo sozinho.
    refetchInterval: (q) => (q.state.data?.estado === "conectando" ? 5_000 : false),
  });
}

function useTrunkSettings(initialData: TrunkSettingsRow | null) {
  return useQuery({
    queryKey,
    queryFn: async () => {
      try {
        const res = await apiClient.get<{ data: TrunkSettingsRow | null }>("/api/v1/voip/trunk");
        return res.data;
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
    initialData,
  });
}

interface FormState {
  host: string;
  port: string;
  username: string;
  password: string;
  from_domain: string;
  is_active: boolean;
}

function estadoInicial(row: TrunkSettingsRow | null): FormState {
  return {
    host: row?.host ?? "",
    port: row ? String(row.port) : "5060",
    username: row?.username ?? "",
    password: "",
    from_domain: row?.from_domain ?? "",
    is_active: row?.is_active ?? true,
  };
}

export function TrunkSettingsClient({
  initialData,
  canWrite,
}: {
  initialData: TrunkSettingsRow | null;
  canWrite: boolean;
}) {
  const t = useT();
  const { data: trunk } = useTrunkSettings(initialData);
  const status = useStatusDoTronco();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>(() => estadoInicial(trunk));
  // O resultado de levar o tronco ao Asterisk, devolvido pelo PUT. Não há mais
  // bloco para colar em pjsip.conf: salvar aplica (lib/voip/tronco-no-asterisk.ts).
  const [aplicacao, setAplicacao] = useState<Aplicacao | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        host: form.host,
        port: Number(form.port),
        username: form.username,
        from_domain: form.from_domain || null,
        is_active: form.is_active,
      };
      if (form.password) body.password = form.password;
      const res = await apiClient.put<{ data: TrunkSettingsRow & { aplicacao?: Aplicacao } }>(
        "/api/v1/voip/trunk",
        body,
      );
      return res.data;
    },
    onSuccess: ({ aplicacao: resultado, ...row }) => {
      setAplicacao(resultado ?? null);
      setForm((f) => ({ ...f, password: "" }));
      queryClient.setQueryData(queryKey, row);
      void queryClient.invalidateQueries({ queryKey: statusKey });
    },
    onError: (err) => showApiError(err),
  });

  const estado = status.data?.estado;
  const descricao = estado ? textosDosEstados(t)[estado] : null;

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <Card data-testid="status-do-tronco">
        <CardHeader>
          <CardTitle>{t("Conexão com o provedor")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {descricao ? (
            <div className="flex items-start gap-3" role="status" data-estado={estado}>
              <span
                aria-hidden
                className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${COR_DO_TOM[descricao.tom]}`}
              />
              <div>
                <p className="text-sm font-medium">{descricao.titulo}</p>
                <p className="text-sm text-muted-foreground">{descricao.texto}</p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {status.isError ? t("Não foi possível verificar agora.") : t("Verificando...")}
            </p>
          )}
          <Button
            variant="outline"
            className="w-fit"
            disabled={status.isFetching}
            onClick={() => void status.refetch()}
          >
            {status.isFetching ? t("Verificando...") : t("Verificar agora")}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("Provedor SIP")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="host">{t("Host")}</Label>
            <Input
              id="host"
              placeholder="sip.provedor.example"
              value={form.host}
              disabled={!canWrite}
              onChange={(e) => setForm((f) => ({ ...f, host: e.target.value }))}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="port">{t("Porta")}</Label>
            <Input
              id="port"
              type="number"
              value={form.port}
              disabled={!canWrite}
              onChange={(e) => setForm((f) => ({ ...f, port: e.target.value }))}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="username">{t("Usuário")}</Label>
            <Input
              id="username"
              value={form.username}
              disabled={!canWrite}
              onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password">
              {t("Senha")}{" "}
              {trunk ? (
                <span className="text-muted-foreground">
                  ({t("configurada, termina em")} {trunk.password_last4})
                </span>
              ) : null}
            </Label>
            <Input
              id="password"
              type="password"
              placeholder={trunk ? t("Deixe em branco para manter a atual") : ""}
              value={form.password}
              disabled={!canWrite}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="from_domain">{t("From-domain (opcional)")}</Label>
            <Input
              id="from_domain"
              placeholder={t("IP público da VPS, se o provedor exigir")}
              value={form.from_domain}
              disabled={!canWrite}
              onChange={(e) => setForm((f) => ({ ...f, from_domain: e.target.value }))}
            />
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id="is_active"
              checked={form.is_active}
              disabled={!canWrite}
              onCheckedChange={(checked) => setForm((f) => ({ ...f, is_active: checked }))}
            />
            <Label htmlFor="is_active">{t("Ativo")}</Label>
          </div>
          {canWrite && (
            <Button
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending}
              className="w-fit"
            >
              {mutation.isPending ? t("Salvando...") : t("Salvar")}
            </Button>
          )}
          {aplicacao ? (
            <p
              role={aplicacao.ok ? "status" : "alert"}
              data-testid="resultado-da-aplicacao"
              className="text-sm text-muted-foreground"
            >
              {aplicacao.ok
                ? t("Salvo e aplicado no servidor de telefonia.")
                : aplicacao.motivo === "sem_telefonia"
                  ? t(
                      "Salvo. A telefonia não está ligada nesta instalação: o tronco entra no ar quando ela for ligada.",
                    )
                  : aplicacao.motivo === "asterisk_inacessivel"
                    ? t(
                        "Salvo, mas o servidor de telefonia não respondeu agora. O tronco é aplicado automaticamente em até 10 minutos.",
                      )
                    : `${t("Salvo, mas o servidor de telefonia recusou a configuração.")} ${aplicacao.detalhe ?? ""}`}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
