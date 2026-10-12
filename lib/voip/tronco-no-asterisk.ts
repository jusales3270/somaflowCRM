/**
 * O TRONCO SIP DE UMA ORGANIZAÇÃO, APLICADO NO ASTERISK PELA ARI — sem arquivo.
 *
 * ═══ O DEFEITO QUE ISTO FECHA ═══
 *
 * A tela Trunk SIP só GUARDAVA o tronco (migration 0349: "aplicar no Asterisk
 * continua MANUAL nesta fase"). Quem instalava digitava os mesmos dados duas
 * vezes — na tela e em `asterisk/pjsip.conf`, na VPS, no nome exato que a tela
 * gerava — e um erro ali só aparecia como "a ligação não completa".
 *
 * ═══ COMO ═══
 *
 * `asterisk/sorcery.conf` diz ao Asterisk que endpoint, aor, auth, identify e
 * registration podem vir TAMBÉM do astdb (banco interno dele, no volume
 * `asterisk-data`, que persiste). A ARI cria esses objetos por
 * `PUT /ari/asterisk/config/dynamic/res_pjsip/{tipo}/{id}` — na hora, sem
 * reload. Provado num Asterisk 20.20.1 (a imagem do compose): criado pela ARI,
 * o registro chegou a `Registered` contra um provedor de teste, sobreviveu a um
 * restart, e a senha errada deu `Rejected`.
 *
 * O arquivo `pjsip.conf` continua sendo lido ANTES (sorcery: `config` primeiro):
 * quem já escreveu o tronco à mão segue funcionando. O transporte (IP público,
 * porta) continua no arquivo — transporte não é criável em tempo de execução.
 *
 * ═══ O REGISTRO É RECRIADO, NUNCA ATUALIZADO ═══
 *
 * Medido: um PUT sobre um `registration` que já existe troca a configuração mas
 * o laço de registro segue tentando o servidor ANTIGO. Por isso a aplicação
 * apaga o registro e o cria de novo.
 *
 * Puro, exceto as funções que recebem `fetch` (testáveis com um falso).
 */
import { nomeDoEndpoint } from "./guardar-trunk";

export const TRANSPORTE_SIP = "transport-udp";
export const CONTEXTO_DE_ENTRADA = "from-trunk";

export interface NomesDoTronco {
  endpoint: string;
  auth: string;
  aor: string;
  identify: string;
  registration: string;
}

/** Os cinco objetos derivam da organização — ninguém digita nome nenhum. */
export function nomesDoTronco(orgId: string): NomesDoTronco {
  const endpoint = nomeDoEndpoint(orgId);
  const base = endpoint.replace(/-endpoint$/, "");
  return {
    endpoint,
    auth: `${base}-auth`,
    aor: `${base}-aor`,
    identify: `${base}-identify`,
    registration: `${base}-reg`,
  };
}

/**
 * O que o originate recebe: `PJSIP/<endpoint>`. A tela grava só o nome do
 * endpoint (`org-<uuid>-trunk-endpoint`) e o `originateCall` faz `split("/")`
 * esperando a tecnologia na frente — sem o prefixo, toda ligação de saída de
 * quem salvou o tronco pela tela quebrava. O valor do env (`VOIP_TRUNK_ENDPOINT`)
 * já vinha com `PJSIP/` e passa intacto.
 */
export function discagemDoEndpoint(endpoint: string): string {
  const nome = endpoint.trim();
  return /^[A-Za-z]+\//.test(nome) ? nome : `PJSIP/${nome}`;
}

export interface DadosDoTronco {
  orgId: string;
  host: string;
  port: number;
  username: string;
  password: string;
  fromDomain: string | null;
}

export type TipoDeObjeto = keyof NomesDoTronco;

export interface ObjetoDoAsterisk {
  tipo: TipoDeObjeto;
  id: string;
  campos: Array<{ attribute: string; value: string }>;
}

function campos(obj: Record<string, string>): ObjetoDoAsterisk["campos"] {
  return Object.entries(obj).map(([attribute, value]) => ({ attribute, value }));
}

/**
 * Os objetos na ORDEM de criação: quem é referenciado nasce antes de quem o
 * referencia (auth e aor antes do endpoint; o registro por último).
 */
export function objetosDoTronco(d: DadosDoTronco): ObjetoDoAsterisk[] {
  const n = nomesDoTronco(d.orgId);
  const servidor = `sip:${d.host}:${d.port}`;
  return [
    {
      tipo: "auth",
      id: n.auth,
      campos: campos({ auth_type: "userpass", username: d.username, password: d.password }),
    },
    {
      tipo: "aor",
      id: n.aor,
      // O qualify é o que faz o endpoint ficar `online` na ARI: a tela lê isso.
      campos: campos({ contact: servidor, qualify_frequency: "60" }),
    },
    {
      tipo: "endpoint",
      id: n.endpoint,
      campos: campos({
        transport: TRANSPORTE_SIP,
        context: CONTEXTO_DE_ENTRADA,
        disallow: "all",
        // μ-law primeiro: casa com o AudioSocket e evita transcodificar.
        allow: "ulaw,alaw",
        outbound_auth: n.auth,
        aors: n.aor,
        from_user: d.username,
        ...(d.fromDomain ? { from_domain: d.fromDomain } : {}),
        // O Asterisk roda atrás do NAT do Docker: mídia e sinalização voltam
        // pelo caminho por onde chegaram.
        direct_media: "no",
        rtp_symmetric: "yes",
        force_rport: "yes",
        rewrite_contact: "yes",
      }),
    },
    {
      tipo: "identify",
      id: n.identify,
      // Reconhece a ligação de ENTRADA vinda do provedor como deste tronco.
      campos: campos({ endpoint: n.endpoint, match: d.host }),
    },
    {
      tipo: "registration",
      id: n.registration,
      campos: campos({
        outbound_auth: n.auth,
        server_uri: servidor,
        client_uri: `sip:${d.username}@${d.host}:${d.port}`,
        transport: TRANSPORTE_SIP,
        retry_interval: "60",
        forbidden_retry_interval: "600",
        // `line` + `endpoint`: a chamada que o provedor manda para o contato
        // registrado cai neste endpoint mesmo sem casar o IP no identify.
        line: "yes",
        endpoint: n.endpoint,
      }),
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// I/O — ARI
// ─────────────────────────────────────────────────────────────────────────────

export interface ConfigDaAri {
  url: string;
  usuario: string;
  senha: string;
}

/**
 * Lida do ambiente. `null` quando a instalação não tem telefonia (o profile
 * `telefonia` do compose não está ligado, ou as credenciais da ARI não foram
 * postas no `.env`): aí não há Asterisk para aplicar nada.
 */
export function configDaAriDoAmbiente(env: Record<string, string | undefined> = process.env): ConfigDaAri | null {
  const url = env.ARI_URL?.trim();
  const usuario = env.ARI_USERNAME?.trim();
  const senha = env.ARI_PASSWORD?.trim();
  if (!url || !usuario || !senha) return null;
  return { url: url.replace(/\/+$/, ""), usuario, senha };
}

export type MotivoDaFalha = "sem_telefonia" | "asterisk_inacessivel" | "recusado_pelo_asterisk";

export type ResultadoNoAsterisk =
  | { ok: true }
  | { ok: false; motivo: MotivoDaFalha; detalhe?: string };

type Buscar = typeof fetch;
const TIMEOUT_MS = 5_000;

async function ari(
  cfg: ConfigDaAri,
  metodo: "GET" | "PUT" | "DELETE",
  caminho: string,
  corpo: unknown,
  buscar: Buscar,
): Promise<{ status: number; texto: string }> {
  const res = await buscar(`${cfg.url}${caminho}`, {
    method: metodo,
    headers: {
      Authorization: `Basic ${Buffer.from(`${cfg.usuario}:${cfg.senha}`).toString("base64")}`,
      ...(corpo ? { "Content-Type": "application/json" } : {}),
    },
    body: corpo ? JSON.stringify(corpo) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return { status: res.status, texto: await res.text().catch(() => "") };
}

const CONFIG_DINAMICA = "/ari/asterisk/config/dynamic/res_pjsip";

export async function asteriskAlcancavel(cfg: ConfigDaAri, buscar: Buscar = fetch): Promise<boolean> {
  try {
    return (await ari(cfg, "GET", "/ari/asterisk/info", null, buscar)).status === 200;
  } catch {
    return false;
  }
}

/** O endpoint do tronco existe no Asterisk (criado pela ARI ou pelo arquivo)? */
export async function troncoPresente(
  orgId: string,
  cfg: ConfigDaAri,
  buscar: Buscar = fetch,
): Promise<boolean> {
  const { endpoint } = nomesDoTronco(orgId);
  const r = await ari(cfg, "GET", `${CONFIG_DINAMICA}/endpoint/${encodeURIComponent(endpoint)}`, null, buscar);
  return r.status === 200;
}

/** O texto de erro da ARI, sem nada que possa carregar a senha. */
function detalheSeguro(tipo: string, status: number, texto: string): string {
  let mensagem = "";
  try {
    mensagem = String((JSON.parse(texto) as { message?: unknown }).message ?? "");
  } catch {
    mensagem = "";
  }
  return `${tipo}: HTTP ${status}${mensagem ? ` — ${mensagem.slice(0, 160)}` : ""}`;
}

export async function aplicarTronco(
  d: DadosDoTronco,
  cfg: ConfigDaAri,
  buscar: Buscar = fetch,
): Promise<ResultadoNoAsterisk> {
  if (!(await asteriskAlcancavel(cfg, buscar))) return { ok: false, motivo: "asterisk_inacessivel" };
  const n = nomesDoTronco(d.orgId);
  // Recriar, nunca atualizar o registro (cabeçalho). 404 = ainda não existia.
  await ari(cfg, "DELETE", `${CONFIG_DINAMICA}/registration/${encodeURIComponent(n.registration)}`, null, buscar);
  for (const o of objetosDoTronco(d)) {
    const r = await ari(
      cfg,
      "PUT",
      `${CONFIG_DINAMICA}/${o.tipo}/${encodeURIComponent(o.id)}`,
      { fields: o.campos },
      buscar,
    );
    if (r.status !== 200) {
      return { ok: false, motivo: "recusado_pelo_asterisk", detalhe: detalheSeguro(o.tipo, r.status, r.texto) };
    }
  }
  return { ok: true };
}

/** Desfaz na ordem inversa da criação. Objeto que já não existia não é erro. */
export async function removerTronco(
  orgId: string,
  cfg: ConfigDaAri,
  buscar: Buscar = fetch,
): Promise<ResultadoNoAsterisk> {
  if (!(await asteriskAlcancavel(cfg, buscar))) return { ok: false, motivo: "asterisk_inacessivel" };
  const n = nomesDoTronco(orgId);
  for (const tipo of ["registration", "identify", "endpoint", "aor", "auth"] as const) {
    const r = await ari(cfg, "DELETE", `${CONFIG_DINAMICA}/${tipo}/${encodeURIComponent(n[tipo])}`, null, buscar);
    if (r.status !== 204 && r.status !== 404) {
      return { ok: false, motivo: "recusado_pelo_asterisk", detalhe: detalheSeguro(tipo, r.status, r.texto) };
    }
  }
  return { ok: true };
}

/** `online` / `offline` / `unknown` — o qualify do provedor, visto pela ARI. */
export async function estadoDoEndpoint(
  orgId: string,
  cfg: ConfigDaAri,
  buscar: Buscar = fetch,
): Promise<string | null> {
  const { endpoint } = nomesDoTronco(orgId);
  try {
    const r = await ari(cfg, "GET", `/ari/endpoints/PJSIP/${encodeURIComponent(endpoint)}`, null, buscar);
    if (r.status !== 200) return null;
    return String((JSON.parse(r.texto) as { state?: unknown }).state ?? "") || null;
  } catch {
    return null;
  }
}
