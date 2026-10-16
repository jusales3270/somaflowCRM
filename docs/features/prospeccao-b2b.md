# Prospecção B2B por CNPJ

Em **CRM › Prospecção**, o seletor no topo tem dois níveis:

- **Negócios locais (Google Maps)** — o motor de sempre ([prospeccao-nativa.md](prospeccao-nativa.md)),
  inalterado: acha negócio de bairro e conduz a abordagem por WhatsApp.
- **Empresas B2B (CNPJ)** — acha empresas pelo **perfil**: atividade (CNAE), estado/cidade e
  **porte na Receita Federal**. É para vender a quem tem estrutura para pagar um serviço de ticket alto.

## Como usar

1. **Fontes** (no topo):
   - **CNPJá — as empresas:** cole a chave da API e salve. O "Testar" mostra o saldo de créditos sem
     gastar nada. Informe o **valor de cada crédito** do seu plano (padrão: R$ 39,99 / 2.500; no plano
     grátis, 0) — é ele que vira R$ em Uso e orçamento.
   - **Treg — os decisores:** cole um token **de equipe** (`treg org agent-new`). O "Testar token"
     confere sem gastar.
   - **Jev — a nota:** a chave do Jev é a de **IA › Provedores** (a mesma das conversas). Sem ela, o
     botão de nota não aparece.
   Toda chave fica cifrada no servidor; a tela só vê os 4 últimos caracteres.
2. **Perfil:** descreva o tipo de empresa e clique em **Sugerir CNAEs**. A IA da organização escolhe
   as atividades de uma pré-lista do catálogo oficial do IBGE (CNAE 2.3), com o motivo de cada uma;
   todo código é conferido contra o catálogo. Sem IA configurada, a sugestão vem pela busca de
   palavras. Também dá para procurar no catálogo à mão.
3. **Onde:** marque os estados; se quiser, as cidades (sem cidade, busca no estado inteiro).
4. **Faturamento:** o padrão é **acima de R$ 4,8 milhões por ano** — o porte "Demais" da Receita.
   Faturamento de empresa privada não é público: o porte é a faixa oficial declarada, e ele sozinho é
   um indício fraco (empresa que nunca se declarou ME/EPP também é "Demais"). Marque **só fora do
   Simples Nacional**: o teto do Simples é R$ 4,8 mi/ano, então quem fatura acima é obrigado a sair.
   Capital social mínimo aperta mais.
5. **Buscar:** a tela mostra o custo máximo antes (1 crédito a cada 10 empresas). A busca para no
   teto pedido e guarda a página seguinte: **Carregar mais** continua dela. O saldo no topo se
   atualiza depois de cada busca.
6. **Nota do Jev:** **Dar nota com o Jev** classifica cada empresa em **alta, média ou baixa**
   aderência ao perfil (a descrição + os filtros), 10 empresas por chamada. Vai para o Jev só dado
   público de pessoa jurídica (atividade, porte, capital, natureza, cidade, abertura) — nunca telefone,
   e-mail ou decisor. O filtro **por nota** mostra só as de uma faixa; "Marcar/Desmarcar todas" valem
   para as mostradas.
7. **Decisores (Treg):** escolha os **cargos** (na ordem em que devem ser tentados), quantas **pessoas
   por empresa** (1 a 3), se quer o **celular** (bem mais caro) e o **teto de gasto** em US$ (a tela
   mostra o equivalente em R$ pela PTAX). **Buscar decisores** roda nas empresas **marcadas** que
   ainda não têm decisor:
   - para cada empresa: busca de pessoas pelo domínio + cargo (sem domínio, nome da empresa + cargo +
     cidade); para cada pessoa achada, o e-mail **com verificação na mesma chamada**; e o celular, se
     pedido;
   - o **teto é duro**: cada chamada sai com o teto do que falta (`X-Treg-Route-Max-Cost`), e a busca
     para sozinha ao bater nele ("Parou no teto de gasto") ou quando o saldo do Treg acaba — o que já
     foi achado fica;
   - pode **fechar a tela**: o cron da prospecção continua a busca de onde parou;
   - retentativa **não paga duas vezes** (chave de idempotência por empresa e passo).
   Na tabela, cada decisor tem **×** = remover e **não buscar de novo** (supressão).
8. **Exportar CSV** (`;`, abre direto no Excel): só as empresas marcadas, **uma linha por decisor**
   (a empresa se repete), com a nota do Jev e o status do e-mail.
9. **Custo:** em **Uso e orçamento**, o card "Prospecção B2B: provedores de dados" mostra o gasto dos
   últimos 30 dias da CNPJá (créditos × valor do crédito) e do Treg (US$ de cada consulta convertido
   pela PTAX do dia). Fica **fora do teto de IA** de propósito — gasto de prospecção não para as
   respostas da IA no WhatsApp. A nota do Jev é IA e aparece no resto da tela.

O B2B **não envia mensagem a ninguém**: quem aborda decide como (ligação, e-mail, LinkedIn).

## Dados e LGPD (registro de legítimo interesse)

- **Finalidade:** encontrar empresas (pessoas jurídicas) com perfil para uma oferta comercial B2B, e a
  pessoa que decide a compra nelas.
- **Minimização:** da empresa, guardamos dado da Receita (CNPJ, razão social, CNAE, porte, capital,
  endereço, telefones). Dos e-mails da empresa, **só o corporativo** entra. Sócios (QSA) não são
  guardados. Do decisor: nome, cargo, LinkedIn, e-mail profissional e (se pedido) celular.
- **Base legal do decisor:** legítimo interesse B2B, gravada na linha.
- **Retenção:** a busca e as empresas seguem o prazo da prospecção (`PROSPECCAO_RETENTION_DAYS`, 365
  dias, piso de 90). O **decisor vale 180 dias** e é apagado pelo cron `data-retention`.
- **Oposição:** "remover e não buscar de novo" apaga o decisor e guarda só o **hash** (sha256) do
  e-mail, do LinkedIn e de nome+CNPJ; nenhuma busca seguinte o grava de novo.
- **Rastro:** salvar chave, buscar, carregar mais, selecionar, dar nota, iniciar/terminar decisores e
  remover decisor auditam `prospecting_b2b.changed`; **exportar** audita `prospecting_b2b.exported`
  com a contagem de empresas e de decisores.
- **Acesso:** só administrador da organização. As tabelas só a service role alcança.

## Por dentro

- Tabelas: 9002 — `prospecting_provider_credentials`, `prospecting_b2b_searches`,
  `prospecting_b2b_companies`; 9003 — `prospecting_b2b_enrichment_runs` (rodada, teto, gasto),
  `prospecting_b2b_enrichment_items` (livro-caixa por empresa, lease), `prospecting_b2b_contacts`,
  `prospecting_b2b_suppressions`, `prospecting_provider_costs` (custo dos provedores, fora de
  `llm_calls`) e `fn_custo_dos_provedores`.
- Código: `lib/prospecting/b2b/` — `cnpja.ts`, `treg.ts`, `decisores.ts`, `qualificar.ts`,
  `custos.ts`, `store.ts`. A chamada do Jev é `ADERENCIA_B2B` (`lib/ai/decisao/tarefas.ts`), sem ponto
  no registro: quem pede é o botão, não as conversas.
- Catálogos oficiais embutidos: `lib/prospecting/b2b/catalogos/*.json` (CNAE 2.3 e municípios do IBGE).
  Para atualizar: `scripts/gerar-catalogos-b2b.ts` (instruções no cabeçalho).
- API: `/api/v1/prospecting/b2b` (sessão ou bearer `dsk_`, admin), `/exportar`, `/catalogos`.
- Teste com dublês: `scripts/duble-cnpja-e2e.mjs`, `scripts/duble-treg-e2e.mjs`,
  `scripts/duble-jev-e2e.mjs` + `tests/e2e/prospeccao-b2b.spec.ts`.
- Prova pela tela: `evidence/prospeccao-b2b/01-perfil.png` (perfil: CNAE sugerido, cidade, porte),
  `evidence/prospeccao-b2b/02-resultados.png` (lista com seleção e exportação),
  `evidence/prospeccao-b2b/03-decisores.png` (nota do Jev e decisores parados no teto) e
  `evidence/prospeccao-b2b/04-uso-e-orcamento.png` (custo dos provedores).

## Próximos passos

- Levar as empresas escolhidas e seus decisores para o CRM (módulo de empresas).
