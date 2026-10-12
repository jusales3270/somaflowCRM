/**
 * O ESTADO DO REGISTRO SIP, LIDO PELA AMI — a única porta que o Asterisk tem.
 *
 * A ARI diz se o provedor RESPONDE (o qualify deixa o endpoint `online`), mas
 * não se ele ACEITOU o login: não há recurso de ARI nem função de dialplan para
 * o registro de saída (conferido no Asterisk 20.20.1). Quem diz é a ação AMI
 * `PJSIPShowRegistrationsOutbound` — `Registered`, `Rejected`, `Unregistered`.
 *
 * O usuário AMI é gerado na subida do contêiner (`asterisk/iniciar.sh`) com
 * `write = reporting` e nada mais: lê estado, não executa comando (medido:
 * `Action: Command` volta `Permission denied`). A senha é a mesma da ARI
 * (`ARI_PASSWORD`, já no `.env`) e a porta 5038 só existe na rede interna.
 *
 * ⚠️ A resposta traz um evento `AuthDetail` por registro, e ele pode carregar a
 * senha do provedor. O parser só olha `OutboundRegistrationDetail` e nada daqui
 * vai para log.
 */
import net from "node:net";

export const USUARIO_AMI = "crm-status";
export const PORTA_AMI = 5038;

export interface ConfigDaAmi {
  host: string;
  porta: number;
  usuario: string;
  senha: string;
}

/** Deriva do ambiente da ARI: mesmo host, porta 5038, mesma senha. */
export function configDaAmiDoAmbiente(env: Record<string, string | undefined> = process.env): ConfigDaAmi | null {
  const url = env.ARI_URL?.trim();
  const senha = env.ARI_PASSWORD?.trim();
  if (!url || !senha) return null;
  try {
    return { host: new URL(url).hostname, porta: PORTA_AMI, usuario: USUARIO_AMI, senha };
  } catch {
    return null;
  }
}

function blocos(texto: string): Array<Record<string, string>> {
  return texto
    .split(/\r?\n\r?\n/)
    .map((bloco) => {
      const campos: Record<string, string> = {};
      for (const linha of bloco.split(/\r?\n/)) {
        const i = linha.indexOf(": ");
        if (i > 0) campos[linha.slice(0, i)] = linha.slice(i + 2);
      }
      return campos;
    })
    .filter((c) => Object.keys(c).length > 0);
}

/** `ObjectName` → `Status`, só dos eventos de registro. Puro. */
export function registrosDaResposta(texto: string): Map<string, string> {
  const mapa = new Map<string, string>();
  for (const c of blocos(texto)) {
    if (c.Event === "OutboundRegistrationDetail" && c.ObjectName && c.Status) {
      mapa.set(c.ObjectName, c.Status);
    }
  }
  return mapa;
}

export type FalhaDaAmi = "inacessivel" | "login_recusado" | "tempo_esgotado";

/**
 * Conecta, autentica, pede os registros e devolve o mapa. Nunca lança: a tela
 * de status não pode cair porque o Asterisk está fora.
 */
export function lerRegistros(
  cfg: ConfigDaAmi,
  timeoutMs = 4_000,
): Promise<{ ok: true; registros: Map<string, string> } | { ok: false; falha: FalhaDaAmi }> {
  return new Promise((resolve) => {
    let buffer = "";
    let fase: "login" | "lista" = "login";
    let fim = false;
    const socket = net.createConnection({ host: cfg.host, port: cfg.porta });

    const terminar = (r: Parameters<typeof resolve>[0]) => {
      if (fim) return;
      fim = true;
      clearTimeout(relogio);
      socket.destroy();
      resolve(r);
    };
    const relogio = setTimeout(() => terminar({ ok: false, falha: "tempo_esgotado" }), timeoutMs);

    socket.on("error", () => terminar({ ok: false, falha: "inacessivel" }));
    socket.on("connect", () => {
      socket.write(
        `Action: Login\r\nUsername: ${cfg.usuario}\r\nSecret: ${cfg.senha}\r\nEvents: off\r\nActionID: login\r\n\r\n`,
      );
    });
    socket.on("data", (pedaco) => {
      buffer += pedaco.toString("utf8");
      if (fase === "login") {
        const resposta = blocos(buffer).find((b) => b.ActionID === "login");
        if (!resposta) return;
        if (resposta.Response !== "Success") return terminar({ ok: false, falha: "login_recusado" });
        fase = "lista";
        buffer = "";
        socket.write("Action: PJSIPShowRegistrationsOutbound\r\nActionID: registros\r\n\r\n");
        return;
      }
      const bs = blocos(buffer);
      if (bs.some((b) => b.Event === "OutboundRegistrationDetailComplete") || bs.some((b) => b.Response === "Error")) {
        terminar({ ok: true, registros: registrosDaResposta(buffer) });
      }
    });
  });
}
