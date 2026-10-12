import net from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { configDaAmiDoAmbiente, lerRegistros, registrosDaResposta, USUARIO_AMI } from "@/lib/voip/ami";
import { estadoDoTronco, type SinaisDoTronco } from "@/lib/voip/tronco-da-organizacao";
import {
  aplicarTronco,
  configDaAriDoAmbiente,
  discagemDoEndpoint,
  nomesDoTronco,
  objetosDoTronco,
  removerTronco,
  type DadosDoTronco,
} from "@/lib/voip/tronco-no-asterisk";

const ORG = "11111111-2222-3333-4444-555555555555";
const DADOS: DadosDoTronco = {
  orgId: ORG,
  host: "sip.provedor.test",
  port: 5060,
  username: "1001",
  password: "s3nh4-do-provedor",
  fromDomain: null,
};
const CFG = { url: "http://asterisk:8088", usuario: "voice-agent-user", senha: "ari" };

describe("nomes e discagem", () => {
  it("os cinco objetos derivam da organização, e o endpoint é o que a tela já gravava", () => {
    expect(nomesDoTronco(ORG)).toEqual({
      endpoint: `org-${ORG}-trunk-endpoint`,
      auth: `org-${ORG}-trunk-auth`,
      aor: `org-${ORG}-trunk-aor`,
      identify: `org-${ORG}-trunk-identify`,
      registration: `org-${ORG}-trunk-reg`,
    });
  });

  it("a discagem ganha o PJSIP/ que o originate exige — e o do env passa intacto", () => {
    // O defeito: a tela grava só o nome, o originateCall faz split("/") e
    // montava "org-…-endpoint/<número>@undefined".
    expect(discagemDoEndpoint(`org-${ORG}-trunk-endpoint`)).toBe(`PJSIP/org-${ORG}-trunk-endpoint`);
    expect(discagemDoEndpoint("PJSIP/trunk-endpoint")).toBe("PJSIP/trunk-endpoint");
    expect(discagemDoEndpoint("  org-x-trunk-endpoint ")).toBe("PJSIP/org-x-trunk-endpoint");
  });
});

describe("objetos do tronco", () => {
  const objetos = objetosDoTronco(DADOS);
  const campos = (tipo: string) =>
    Object.fromEntries(objetos.find((o) => o.tipo === tipo)!.campos.map((c) => [c.attribute, c.value]));

  it("na ordem de criação: o referenciado antes de quem referencia, o registro por último", () => {
    expect(objetos.map((o) => o.tipo)).toEqual(["auth", "aor", "endpoint", "identify", "registration"]);
  });

  it("o endpoint aponta para auth e aor, entra pelo contexto do agente e atravessa o NAT", () => {
    const n = nomesDoTronco(ORG);
    expect(campos("endpoint")).toMatchObject({
      transport: "transport-udp",
      context: "from-trunk",
      outbound_auth: n.auth,
      aors: n.aor,
      allow: "ulaw,alaw",
      rtp_symmetric: "yes",
      force_rport: "yes",
      rewrite_contact: "yes",
    });
    expect(campos("endpoint")).not.toHaveProperty("from_domain");
    expect(campos("aor")).toMatchObject({ contact: "sip:sip.provedor.test:5060" });
    expect(campos("identify")).toMatchObject({ endpoint: n.endpoint, match: "sip.provedor.test" });
  });

  it("o registro usa o usuário no client_uri e liga a linha ao endpoint", () => {
    expect(campos("registration")).toMatchObject({
      server_uri: "sip:sip.provedor.test:5060",
      client_uri: "sip:1001@sip.provedor.test:5060",
      line: "yes",
      endpoint: nomesDoTronco(ORG).endpoint,
    });
  });

  it("from_domain só entra quando a tela o preencheu", () => {
    const comDominio = objetosDoTronco({ ...DADOS, fromDomain: "203.0.113.7" });
    const ep = comDominio.find((o) => o.tipo === "endpoint")!;
    expect(ep.campos).toContainEqual({ attribute: "from_domain", value: "203.0.113.7" });
  });
});

/** Um Asterisk falso: registra as chamadas e responde por rota. */
function ariFalsa(responder: (metodo: string, caminho: string) => number = () => 200) {
  const chamadas: Array<{ metodo: string; caminho: string; corpo: string }> = [];
  const buscar = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const caminho = String(url).replace(CFG.url, "");
    const metodo = init?.method ?? "GET";
    chamadas.push({ metodo, caminho, corpo: String(init?.body ?? "") });
    const status = caminho === "/ari/asterisk/info" ? 200 : responder(metodo, caminho);
    return new Response(status === 204 ? null : JSON.stringify({ message: "falso" }), { status });
  });
  return { buscar: buscar as unknown as typeof fetch, chamadas };
}

describe("aplicar e remover pela ARI", () => {
  it("apaga o registro antigo e cria os cinco objetos, nessa ordem", async () => {
    const { buscar, chamadas } = ariFalsa((m) => (m === "DELETE" ? 404 : 200));
    expect(await aplicarTronco(DADOS, CFG, buscar)).toEqual({ ok: true });
    const escritas = chamadas.filter((c) => c.caminho !== "/ari/asterisk/info");
    expect(escritas.map((c) => `${c.metodo} ${c.caminho.split("/res_pjsip/")[1]}`)).toEqual([
      `DELETE registration/org-${ORG}-trunk-reg`,
      `PUT auth/org-${ORG}-trunk-auth`,
      `PUT aor/org-${ORG}-trunk-aor`,
      `PUT endpoint/org-${ORG}-trunk-endpoint`,
      `PUT identify/org-${ORG}-trunk-identify`,
      `PUT registration/org-${ORG}-trunk-reg`,
    ]);
    expect(JSON.parse(escritas[1]!.corpo)).toEqual({
      fields: [
        { attribute: "auth_type", value: "userpass" },
        { attribute: "username", value: "1001" },
        { attribute: "password", value: "s3nh4-do-provedor" },
      ],
    });
  });

  it("Asterisk fora: não tenta escrever nada", async () => {
    const buscar = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND asterisk");
    }) as unknown as typeof fetch;
    expect(await aplicarTronco(DADOS, CFG, buscar)).toEqual({ ok: false, motivo: "asterisk_inacessivel" });
  });

  it("recusa do Asterisk diz QUAL objeto — e o detalhe nunca carrega a senha", async () => {
    const { buscar } = ariFalsa((m, c) => (m === "PUT" && c.includes("/endpoint/") ? 400 : m === "DELETE" ? 404 : 200));
    const r = await aplicarTronco(DADOS, CFG, buscar);
    expect(r).toMatchObject({ ok: false, motivo: "recusado_pelo_asterisk" });
    expect(r.ok ? "" : r.detalhe).toContain("endpoint: HTTP 400");
    expect(JSON.stringify(r)).not.toContain(DADOS.password);
  });

  it("remover desfaz na ordem inversa, e objeto que não existia não é erro", async () => {
    const { buscar, chamadas } = ariFalsa((m, c) => (c.includes("/identify/") ? 404 : 204));
    expect(await removerTronco(ORG, CFG, buscar)).toEqual({ ok: true });
    expect(
      chamadas.filter((c) => c.metodo === "DELETE").map((c) => c.caminho.split("/res_pjsip/")[1]!.split("/")[0]),
    ).toEqual(["registration", "identify", "endpoint", "aor", "auth"]);
  });

  it("sem as credenciais da ARI no ambiente, a instalação não tem telefonia", () => {
    expect(configDaAriDoAmbiente({})).toBeNull();
    expect(configDaAriDoAmbiente({ ARI_URL: "http://asterisk:8088", ARI_USERNAME: "u" })).toBeNull();
    expect(
      configDaAriDoAmbiente({ ARI_URL: "http://asterisk:8088/", ARI_USERNAME: "u", ARI_PASSWORD: "p" }),
    ).toEqual({ url: "http://asterisk:8088", usuario: "u", senha: "p" });
  });
});

describe("AMI — o estado do registro", () => {
  const RESPOSTA =
    "Response: Success\r\nActionID: registros\r\nEventList: start\r\nMessage: Following are Events for each Outbound registration\r\n\r\n" +
    `Event: OutboundRegistrationDetail\r\nObjectName: org-${ORG}-trunk-reg\r\nStatus: Registered\r\nServerUri: sip:x\r\n\r\n` +
    "Event: AuthDetail\r\nObjectName: org-x-trunk-auth\r\nUsername: 1001\r\nPassword: NAO-PODE-APARECER\r\n\r\n" +
    "Event: OutboundRegistrationDetail\r\nObjectName: outra-reg\r\nStatus: Rejected\r\n\r\n" +
    "Event: OutboundRegistrationDetailComplete\r\nEventList: Complete\r\nListItems: 2\r\n\r\n";

  it("lê só os eventos de registro — o AuthDetail (que pode ter a senha) fica de fora", () => {
    const mapa = registrosDaResposta(RESPOSTA);
    expect([...mapa.entries()]).toEqual([
      [`org-${ORG}-trunk-reg`, "Registered"],
      ["outra-reg", "Rejected"],
    ]);
    expect(JSON.stringify([...mapa])).not.toContain("NAO-PODE-APARECER");
  });

  it("deriva da ARI: mesmo host, porta 5038, usuário de consulta, mesma senha", () => {
    expect(configDaAmiDoAmbiente({ ARI_URL: "http://asterisk:8088", ARI_PASSWORD: "p" })).toEqual({
      host: "asterisk",
      porta: 5038,
      usuario: USUARIO_AMI,
      senha: "p",
    });
    expect(configDaAmiDoAmbiente({})).toBeNull();
  });

  let servidor: net.Server | null = null;
  afterEach(() => {
    servidor?.close();
    servidor = null;
  });

  async function amiFalsa(aceitaLogin: boolean): Promise<number> {
    servidor = net.createServer((s) => {
      s.write("Asterisk Call Manager/9.0.0\r\n");
      s.on("data", (d) => {
        const texto = d.toString();
        if (texto.includes("Action: Login")) {
          s.write(
            aceitaLogin
              ? "Response: Success\r\nActionID: login\r\nMessage: Authentication accepted\r\n\r\n"
              : "Response: Error\r\nActionID: login\r\nMessage: Authentication failed\r\n\r\n",
          );
        } else if (texto.includes("PJSIPShowRegistrationsOutbound")) {
          s.write(RESPOSTA);
        }
      });
    });
    await new Promise<void>((r) => servidor!.listen(0, "127.0.0.1", r));
    return (servidor.address() as net.AddressInfo).port;
  }

  it("conecta, autentica e devolve o mapa", async () => {
    const porta = await amiFalsa(true);
    const r = await lerRegistros({ host: "127.0.0.1", porta, usuario: USUARIO_AMI, senha: "p" });
    expect(r.ok && r.registros.get(`org-${ORG}-trunk-reg`)).toBe("Registered");
  });

  it("login recusado e porta fechada viram falha — nunca exceção", async () => {
    const porta = await amiFalsa(false);
    expect(await lerRegistros({ host: "127.0.0.1", porta, usuario: USUARIO_AMI, senha: "x" })).toEqual({
      ok: false,
      falha: "login_recusado",
    });
    servidor!.close();
    servidor = null;
    expect(await lerRegistros({ host: "127.0.0.1", porta, usuario: USUARIO_AMI, senha: "x" }, 1_000)).toEqual({
      ok: false,
      falha: "inacessivel",
    });
  });
});

describe("um estado só, na ordem em que se resolve", () => {
  const base: SinaisDoTronco = {
    cadastrado: true,
    ativo: true,
    telefonia: true,
    alcancavel: true,
    presente: true,
    registro: "Registered",
    endpoint: "online",
  };

  it.each([
    [{ cadastrado: false }, "nao_cadastrado"],
    [{ telefonia: false }, "sem_telefonia"],
    [{ alcancavel: false }, "asterisk_fora"],
    [{ ativo: false }, "desativado"],
    [{ presente: false }, "nao_aplicado"],
    [{}, "conectado"],
    [{ registro: "Rejected" }, "recusado"],
    [{ registro: "Unregistered", endpoint: "online" }, "conectando"],
    [{ registro: "Unregistered", endpoint: "offline" }, "sem_resposta"],
    [{ registro: null, endpoint: "online" }, "provedor_responde"],
    [{ registro: null, endpoint: "offline" }, "sem_resposta"],
  ] as const)("%o → %s", (mudanca, esperado) => {
    expect(estadoDoTronco({ ...base, ...mudanca })).toBe(esperado);
  });
});
