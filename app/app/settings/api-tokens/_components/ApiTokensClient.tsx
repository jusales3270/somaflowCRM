"use client";

import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useState } from "react";
import { toast } from "sonner";

import {
  useApiTokens,
  useCreateApiToken,
  useRevokeApiToken,
  type CreatedApiToken,
} from "@/hooks/team/useApiTokens";
import { copyToClipboard } from "@/lib/clipboard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useT } from "@/hooks/i18n/useT";
import {
  comandoDoClaudeMcpAdd,
  comandosDoCodex,
  ESCOPOS_DO_ASSISTENTE,
  VALIDADE_DO_TOKEN_DO_ASSISTENTE_DIAS,
} from "@/lib/mcp/conectar-assistente";

/**
 * `mcp:read`/`mcp:write` faltavam nesta lista, e sem eles NENHUMA ferramenta
 * MCP funciona: toda chamada volta "Token missing required scope 'mcp:read'"
 * (lib/mcp/types.ts exige um dos dois em cada tool). Como esta tela é o único
 * lugar que emite token, o "CRM operável por agentes de IA via MCP" ficava
 * inalcançável — a API sempre aceitou os escopos; só o catálogo daqui os
 * escondia.
 */
const SCOPES: { id: string; label: string }[] = [
  { id: "mcp:read", label: "Agentes de IA podem LER o CRM (MCP)" },
  { id: "mcp:write", label: "Agentes de IA podem AGIR no CRM (MCP)" },
  // Sem isto o token nasce como 'agent' e as ferramentas de nível gerente
  // (criar lead, atribuir conversa) respondem "Role 'agent' insufficient".
  // O papel viaja junto dos escopos (ver lib/mcp/auth.ts) e também não
  // aparecia em lugar nenhum da interface.
  { id: "role:manager", label: "Tratar o token como gerente (necessário p/ criar e atribuir)" },
  { id: "contacts:read", label: "Ler contatos" },
  { id: "contacts:write", label: "Criar e editar contatos" },
  { id: "leads:read", label: "Ler leads" },
  { id: "leads:write", label: "Criar e editar leads" },
  { id: "messages:read", label: "Ler mensagens" },
  { id: "messages:write", label: "Enviar mensagens" },
  // #1613: sem esta linha o escopo existia na rota e ninguém conseguia concedê-lo.
  { id: "messages:on_behalf", label: "Integração pode enviar em nome de um atendente" },
  { id: "audit:read", label: "Ler o log de auditoria" },
];

interface Props {
  /** Presente só para quem administra a instalação (ver a page). */
  conectarAssistente?: { urlDaInstalacao: string } | null;
}

export function ApiTokensClient({ conectarAssistente = null }: Props = {}) {
  const tagDoIdioma = useTagDeIdioma();
  const t = useT();
  const { data, isLoading } = useApiTokens();
  const create = useCreateApiToken();
  const revoke = useRevokeApiToken();

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [expiresInDays, setExpiresInDays] = useState<string>("");
  const [created, setCreated] = useState<CreatedApiToken | null>(null);
  // O token recém-criado É o do assistente: só então o diálogo mostra os comandos prontos.
  const [doAssistente, setDoAssistente] = useState(false);

  const criarTokenDoAssistente = async () => {
    try {
      const res = await create.mutateAsync({
        name: t("Assistente de IA (administração)"),
        scopes: [...ESCOPOS_DO_ASSISTENTE],
        expires_in_days: VALIDADE_DO_TOKEN_DO_ASSISTENTE_DIAS,
      });
      setDoAssistente(true);
      setCreated(res.data);
    } catch {
      /* noop — o hook já mostra o erro */
    }
  };

  const tokens = data?.data ?? [];

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (scopes.length === 0) {
      toast.error(t("Selecione ao menos um escopo."));
      return;
    }
    try {
      const res = await create.mutateAsync({
        name,
        scopes,
        expires_in_days: expiresInDays ? Number(expiresInDays) : undefined,
      });
      setDoAssistente(false);
      setCreated(res.data);
      setName("");
      setScopes([]);
      setExpiresInDays("");
      setCreateOpen(false);
    } catch {
      /* noop */
    }
  };

  const toggleScope = (s: string) => {
    setScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  };

  return (
    <>
      {conectarAssistente ? (
        <section
          data-testid="conectar-assistente"
          className="space-y-2 rounded-md border border-border p-4"
        >
          <h2 className="text-sm font-semibold">{t("Conectar seu assistente de IA")}</h2>
          <p className="text-sm text-muted-foreground">
            {t(
              "Use o Claude Code (assinatura do Claude) ou o Codex (assinatura do ChatGPT) para consultar e operar o CRM pelo terminal. O assistente roda na sua máquina e chama o CRM com um token de administrador; a sua assinatura nunca fica guardada aqui. Os agentes que atendem clientes continuam usando chave de API.",
            )}
          </p>
          <Button
            type="button"
            variant="secondary"
            disabled={create.isPending}
            onClick={() => void criarTokenDoAssistente()}
          >
            {t("Criar token para o assistente")}
          </Button>
        </section>
      ) : null}

      <div className="flex sm:justify-end">
        <Button onClick={() => setCreateOpen(true)} className="w-full sm:w-auto">
          {t("Criar token")}
        </Button>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>
      ) : tokens.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("Nenhum token criado ainda.")}</p>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("Nome")}</TableHead>
                <TableHead>{t("Prefixo")}</TableHead>
                <TableHead>{t("Escopos")}</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>{t("Expira")}</TableHead>
                <TableHead className="w-[120px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {tokens.map((tok) => (
                <TableRow key={tok.id}>
                  <TableCell className="font-medium">{tok.name}</TableCell>
                  <TableCell>
                    <code className="text-xs">{tok.prefix}…</code>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {tok.scopes.map((s) => (
                        <Badge key={s} variant="secondary" className="text-xs">
                          {s}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    {tok.revoked_at ? (
                      <Badge variant="destructive">{t("Revogado")}</Badge>
                    ) : (
                      <Badge variant="default">{t("Ativo")}</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {tok.expires_at
                      ? new Date(tok.expires_at).toLocaleDateString(tagDoIdioma)
                      : "—"}
                  </TableCell>
                  <TableCell>
                    {!tok.revoked_at ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={revoke.isPending}
                        onClick={async () => {
                          await revoke.mutateAsync(tok.id);
                          toast.success(t("Token revogado."));
                        }}
                      >
                        {t("Revogar")}
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Criar novo token")}</DialogTitle>
            <DialogDescription>{t("O plaintext será mostrado apenas uma vez.")}</DialogDescription>
          </DialogHeader>
          <form onSubmit={onCreate} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="t-name">{t("Nome")}</Label>
              <Input
                id="t-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("Worker de import")}
                minLength={2}
                maxLength={100}
                required
              />
            </div>
            <div className="space-y-2">
              <Label>{t("Escopos")}</Label>
              <div className="flex flex-wrap gap-2">
                {SCOPES.map((s) => (
                  <button
                    type="button"
                    key={s.id}
                    onClick={() => toggleScope(s.id)}
                    title={t(s.label)}
                    aria-label={`${s.id} — ${t(s.label)}`}
                    className={`rounded-md border px-2 py-1 text-xs ${
                      scopes.includes(s.id) ? "border-primary bg-primary/10" : "border-border"
                    }`}
                  >
                    {s.id}
                    <span className="ml-1 text-muted-foreground">· {t(s.label)}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="t-exp">{t("Expira em (dias) — opcional")}</Label>
              <Input
                id="t-exp"
                type="number"
                min={1}
                max={365}
                value={expiresInDays}
                onChange={(e) => setExpiresInDays(e.target.value)}
                placeholder="365"
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>
                {t("Cancelar")}
              </Button>
              <Button type="submit" disabled={create.isPending}>
                {t("Criar")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!created}
        onOpenChange={(o) => {
          if (!o) {
            setCreated(null);
            setDoAssistente(false);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Token criado")}</DialogTitle>
            <DialogDescription>
              {t("Copie e guarde agora — não conseguiremos exibir novamente.")}
            </DialogDescription>
          </DialogHeader>
          {created ? (
            <div className="space-y-3">
              <code className="block rounded-md border bg-muted p-3 text-sm break-all">
                {created.plaintext}
              </code>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  void copyToClipboard(created.plaintext).then((ok) => {
                    if (ok) toast.success(t("Token copiado."));
                    else toast.error(t("Não foi possível copiar — selecione o token acima."));
                  });
                }}
              >
                {t("Copiar para clipboard")}
              </Button>
              <p className="text-xs text-muted-foreground">{created._warning}</p>
              {doAssistente && conectarAssistente ? (
                <ComandosDoAssistente
                  claude={comandoDoClaudeMcpAdd({
                    urlDaInstalacao: conectarAssistente.urlDaInstalacao,
                    token: created.plaintext,
                  })}
                  codex={comandosDoCodex({
                    urlDaInstalacao: conectarAssistente.urlDaInstalacao,
                    token: created.plaintext,
                  })}
                />
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button
              onClick={() => {
                setCreated(null);
                setDoAssistente(false);
              }}
            >
              {t("Fechar")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Um comando com o botão de copiar. */
function BlocoDeComando({ comando, testId }: { comando: string; testId: string }) {
  const t = useT();
  return (
    <div className="space-y-2">
      <code
        data-testid={testId}
        className="block rounded-md border bg-muted p-3 font-mono text-xs break-all"
      >
        {comando}
      </code>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => {
          void copyToClipboard(comando).then((ok) => {
            if (ok) toast.success(t("Comando copiado."));
            else toast.error(t("Não foi possível copiar — selecione o comando acima."));
          });
        }}
      >
        {t("Copiar comando")}
      </Button>
    </div>
  );
}

/**
 * Os comandos prontos, para quem administra escolher o assistente. Montados pela mesma
 * regra do `pnpm conectar-claude` / `pnpm conectar-codex` (`lib/mcp/conectar-assistente.ts`).
 */
function ComandosDoAssistente({ claude, codex }: { claude: string; codex: string[] }) {
  const t = useT();
  const [cliente, setCliente] = useState<"claude" | "codex">("claude");
  return (
    <div data-testid="comandos-do-assistente" className="space-y-3 border-t pt-3">
      <p className="text-sm font-medium">
        {t("Escolha o assistente e cole no terminal da sua máquina:")}
      </p>
      <div role="tablist" className="flex gap-2">
        {(
          [
            ["claude", "Claude Code"],
            ["codex", "Codex"],
          ] as const
        ).map(([id, rotulo]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={cliente === id}
            onClick={() => setCliente(id)}
            className={`rounded-md border px-3 py-1 text-xs ${
              cliente === id ? "border-primary bg-primary/10" : "border-border"
            }`}
          >
            {rotulo}
          </button>
        ))}
      </div>
      {cliente === "claude" ? (
        <BlocoDeComando comando={claude} testId="comando-claude-code" />
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            {t(
              "O Codex lê o token de uma variável de ambiente. Cole os dois comandos, nesta ordem:",
            )}
          </p>
          <BlocoDeComando comando={codex[0] ?? ""} testId="comando-codex-token" />
          <BlocoDeComando comando={codex[1] ?? ""} testId="comando-codex" />
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        {t(
          'Depois, abra o assistente e peça, por exemplo: "quais negócios esfriaram esta semana?". O token vale 90 dias e pode ser revogado nesta tela.',
        )}
      </p>
    </div>
  );
}
