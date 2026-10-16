# Prospecção B2B por CNPJ

Em **CRM › Prospecção**, o seletor no topo tem dois níveis:

- **Negócios locais (Google Maps)** — o motor de sempre ([prospeccao-nativa.md](prospeccao-nativa.md)),
  inalterado: acha negócio de bairro e conduz a abordagem por WhatsApp.
- **Empresas B2B (CNPJ)** — acha empresas pelo **perfil**: atividade (CNAE), estado/cidade e
  **porte na Receita Federal**. É para vender a quem tem estrutura para pagar um serviço de ticket alto.

## Como usar

1. **Fonte:** cole a chave da API da **CNPJá** (cnpja.com) e salve. O "Testar" mostra o saldo de
   créditos sem gastar nada. A chave fica cifrada no servidor; a tela só vê os 4 últimos caracteres.
2. **Perfil:** descreva o tipo de empresa e clique em **Sugerir CNAEs**. A IA da organização escolhe
   as atividades de uma pré-lista do catálogo oficial do IBGE (CNAE 2.3), com o motivo de cada uma;
   todo código é conferido contra o catálogo. Sem IA configurada, a sugestão vem pela busca de
   palavras. Também dá para procurar no catálogo à mão.
3. **Onde:** marque os estados; se quiser, as cidades (sem cidade, busca no estado inteiro).
4. **Faturamento:** o padrão é **acima de R$ 4,8 milhões por ano** — o porte "Demais" da Receita.
   Faturamento de empresa privada não é público: o porte é a faixa oficial declarada. Para apertar,
   há "só fora do Simples Nacional" e "capital social mínimo".
5. **Buscar:** a tela mostra o custo máximo antes (1 crédito a cada 10 empresas). A busca para no
   teto pedido e guarda a página seguinte: **Carregar mais** continua dela.
6. **Lista e exportação:** marque e desmarque empresas e **Exportar CSV** (`;`, abre direto no Excel).
   O B2B **não envia mensagem a ninguém**: quem aborda decide como (ligação, e-mail, LinkedIn).

## Dados e LGPD (registro de legítimo interesse)

- **Finalidade:** encontrar empresas (pessoas jurídicas) com perfil para uma oferta comercial B2B.
- **Minimização:** guardamos dado de **empresa** da Receita (CNPJ, razão social, CNAE, porte, capital,
  endereço, telefones). Dos e-mails, **só o corporativo** entra: o da contabilidade e o pessoal ficam
  fora (`lib/prospecting/b2b/cnpja.ts`). Sócios (QSA) não são guardados.
- **Retenção:** a busca e as empresas dela são apagadas pelo mesmo prazo da prospecção
  (`PROSPECCAO_RETENTION_DAYS`, 365 dias por padrão, piso de 90), no cron `data-retention`.
- **Rastro:** salvar chave, buscar, carregar mais e selecionar auditam `prospecting_b2b.changed`;
  **exportar** audita `prospecting_b2b.exported` com a contagem.
- **Acesso:** só administrador da organização. As tabelas só a service role alcança.

## Por dentro

- Tabelas (migration 9002): `prospecting_provider_credentials`, `prospecting_b2b_searches`,
  `prospecting_b2b_companies` — próprias, separadas da fila de WhatsApp do Google Maps.
- Catálogos oficiais embutidos: `lib/prospecting/b2b/catalogos/*.json` (CNAE 2.3 e municípios do IBGE).
  Para atualizar: `scripts/gerar-catalogos-b2b.ts` (instruções no cabeçalho).
- API: `/api/v1/prospecting/b2b` (sessão ou bearer `dsk_`, admin), `/exportar`, `/catalogos`.
- Teste com dublê: `scripts/duble-cnpja-e2e.mjs` + `tests/e2e/prospeccao-b2b.spec.ts`.

## Próximos passos

- **Decisores** (nome, cargo, e-mail verificado, celular) via Treg, por empresa selecionada, com teto
  de gasto.
- **Qualificação pelo Jev:** nota de aderência ao perfil para cada empresa.
- Levar as empresas escolhidas para o CRM (módulo de empresas).
