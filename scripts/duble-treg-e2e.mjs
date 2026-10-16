#!/usr/bin/env node
/**
 * Dublê do Treg para o e2e da prospecção B2B (decisores).
 *
 * Imita o contrato conferido no catálogo público do Treg (16/10/2026):
 *   GET  /tools                          → 200 com o token certo; 401 sem/errado
 *   POST /call/treg.people.search        → { output: { people: [...] }, _treg }
 *   POST /call/treg.people.email.find    → { output: { email, verified }, _treg: { verification } }
 *   POST /call/treg.people.phone.find    → { output: { phone, line_type }, _treg }
 * e o dinheiro:
 *   - `X-Treg-Cost-Micro` em toda chamada cobrada (acerto paga; "não achou" é grátis);
 *   - `X-Treg-Route-Max-Cost` menor que o preço → 402 `route_max_cost`, sem cobrar;
 *   - saldo (DUBLE_TREG_SALDO_MICRO) que acaba → 402 `insufficient_balance`;
 *   - `Idempotency-Key` repetida → a mesma resposta com custo 0 (replay).
 *
 * Domínio com "semgente" não tem ninguém (miss grátis). Toda chamada é gravada em
 * DUBLE_TREG_ARQUIVO para a spec conferir o que saiu (token, teto, chave).
 */
import fs from "node:fs";
import http from "node:http";

const PORTA = Number(process.env.DUBLE_TREG_PORTA ?? 3993);
const CHAVE = process.env.DUBLE_TREG_CHAVE ?? "treg_e2e_duble_0123456789";
const ARQUIVO = process.env.DUBLE_TREG_ARQUIVO;
let saldo = Number(process.env.DUBLE_TREG_SALDO_MICRO ?? 1_000_000);
const PRECO = { "treg.people.search": 20_000, "treg.people.email.find": 5_000, "treg.people.phone.find": 30_000 };

const chamadas = [];
const replays = new Map();
let seq = 0;

function gravar(c) {
  chamadas.push(c);
  if (ARQUIVO) fs.writeFileSync(ARQUIVO, JSON.stringify(chamadas));
}

function lerCorpo(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      try {
        resolve(b ? JSON.parse(b) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function slug(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.|\.$/g, "");
}

function responder(res, status, corpo, custo = 0) {
  seq += 1;
  res.writeHead(status, {
    "Content-Type": "application/json",
    "X-Treg-Cost-Micro": String(custo),
    "X-Treg-Call-Id": `call_duble_${seq}`,
    "X-Treg-Served-By": "duble",
  });
  res.end(JSON.stringify(corpo));
}

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORTA}`);
  if (url.pathname === "/__duble/saude") return responder(res, 200, { ok: true, porta: PORTA, arquivo: ARQUIVO ?? null, saldo });
  const autorizada = req.headers["x-treg-token"] === CHAVE;
  const corpo = req.method === "POST" ? await lerCorpo(req) : {};
  const capacidade = url.pathname.replace(/^\/call\//, "");
  gravar({
    caminho: url.pathname,
    autorizada,
    corpo,
    teto: req.headers["x-treg-route-max-cost"] ?? null,
    chave: req.headers["idempotency-key"] ?? null,
    meta: req.headers["x-treg-meta"] ?? null,
    verificar: req.headers["x-treg-route-verify"] ?? null,
  });
  if (!autorizada) return responder(res, 401, { detail: "not authenticated" });
  if (url.pathname === "/tools") return responder(res, 200, { tools: [] });
  if (!(capacidade in PRECO)) return responder(res, 404, { detail: "unknown endpoint" });

  const chave = req.headers["idempotency-key"];
  if (chave && replays.has(chave)) {
    const r = replays.get(chave);
    return responder(res, r.status, r.corpo, 0);
  }

  const dominio = String(corpo.company_domain ?? corpo.domain ?? "");
  const achou = !dominio.includes("semgente");
  const preco = achou ? PRECO[capacidade] : 0;
  const teto = Math.round(Number(req.headers["x-treg-route-max-cost"] ?? 1) * 1_000_000);
  if (preco > teto) return responder(res, 402, { error: "route_max_cost", max_cost_micro: teto, estimated_cost_micro: preco });
  if (preco > saldo) return responder(res, 402, { error: "insufficient_balance", balance_micro: saldo, topup_url: "https://treg.to/billing" });

  let resposta;
  if (capacidade === "treg.people.search") {
    const empresa = dominio.split(".")[0] || slug(corpo.q).split(".").slice(-1)[0] || "empresa";
    // Como o Treg real: o provedor ignora o cargo e devolve a equipe — inclusive
    // quem não decide (o operador) e, sem domínio, gente de OUTRA empresa.
    resposta = {
      output: {
        people: achou
          ? [
              { full_name: `Operador ${empresa}`, title: "Operador de máquina", company_domain: dominio || null },
              ...(dominio ? [] : [{ full_name: "Diretor De Outra", title: "Diretor", company_name: "Outra Empresa Qualquer" }]),
              {
                full_name: `Pessoa 1 ${empresa}`,
                title: "Diretor Industrial",
                linkedin_url: `https://www.linkedin.com/in/pessoa-1-${empresa}`,
                company_domain: dominio || null,
              },
            ]
          : [],
        count: achou ? 2 : 0,
      },
      raw: {},
      _treg: { served_by: "duble", tried: ["duble"] },
    };
  } else if (capacidade === "treg.people.email.find") {
    resposta = {
      output: achou ? { email: `${slug(corpo.full_name)}@${dominio || "exemplo.com.br"}`, verified: true, confidence: 0.95 } : { email: null },
      raw: {},
      _treg: { served_by: "duble", tried: ["duble"], verification: achou ? { verdict: "valid", checked: true } : undefined },
    };
  } else {
    resposta = {
      output: achou ? { phone: "+5519999990000", line_type: "mobile", country_code: "BR" } : { phone: null },
      raw: {},
      _treg: { served_by: "duble", tried: ["duble"] },
    };
  }
  saldo -= preco;
  if (chave) replays.set(chave, { status: 200, corpo: resposta });
  return responder(res, 200, resposta, preco);
});

servidor.listen(PORTA, "127.0.0.1", () => {
  process.stdout.write(`duble-treg ouvindo em 127.0.0.1:${PORTA}\n`);
});
for (const sinal of ["SIGTERM", "SIGINT"]) process.on(sinal, () => servidor.close(() => process.exit(0)));
