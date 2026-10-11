# Custo das ligações de voz, em reais

Onde ver: **IA › Uso de IA**, card **Ligações de voz** (aparece quando a organização teve
ligação nos últimos 30 dias; só gerente e administrador veem a tela).

## O que o card mostra

- **Custo em reais** dos últimos 30 dias, com o mesmo valor em dólar embaixo;
- quantas ligações e quantos minutos;
- **média por ligação** e **custo por minuto**, em reais;
- as 10 ligações mais recentes: duração, modelo, custo em dólar, a cotação usada e o custo em reais;
- a cotação mais recente guardada (PTAX, Banco Central do Brasil).

## Como o custo é calculado

1. **Em dólar, no fim de cada ligação.** O agente de voz soma o uso que a própria OpenAI
   informa a cada resposta (`response.done`) — tokens de áudio e de texto, de entrada e de
   saída, e a parte da entrada que veio do cache — e aplica a tarifa oficial do modelo
   (`workers/voice-agent/tarifa-realtime.ts`). O resultado vai para `llm_calls.cost_cents`,
   em centavos de dólar, e por isso a ligação também passa a contar no **orçamento mensal
   de IA** e no total de Uso de IA.

   | Modelo (US$ por 1 milhão de tokens) | Áudio entrada | Áudio cache | Áudio saída | Texto entrada | Texto cache | Texto saída |
   |---|---|---|---|---|---|---|
   | `gpt-realtime` | 32 | 0,40 | 64 | 4 | 0,40 | 16 |
   | `gpt-realtime-2` / `-2.1` | 32 | 0,40 | 64 | 4 | 0,40 | 24 |
   | `gpt-realtime-mini` / `-2.1-mini` | 10 | 0,30 | 20 | 0,60 | 0,06 | 2,40 |

   Fonte: <https://developers.openai.com/api/docs/pricing>, conferida em 11/10/2026. Modelo
   fora da tabela fica **sem preço** (o card avisa), nunca como grátis.

2. **Em reais, pela cotação do dia da ligação.** Todo dia o cron `cotacao-do-dolar` busca a
   PTAX de venda no Banco Central (13h40 e 20h10 de Brasília) e a guarda por dia. Cada
   ligação usa a cotação do dia dela; fim de semana e feriado usam a do último dia útil.
   O custo de uma ligação de setembro não muda quando o dólar muda em outubro.

Não há variável de ambiente nova: a API da PTAX é pública e não pede chave.

## Exemplo: uma ligação de 10 minutos

Uma conversa típica, metade do tempo cada lado falando, com o `gpt-realtime` e o cache da
OpenAI funcionando, sai por volta de **US$ 0,48**. Na PTAX de 09/10/2026 (R$ 4,9892), dá
**R$ 2,39** — cerca de **R$ 0,24 por minuto**. Com o `gpt-realtime-mini`, cerca de
**R$ 0,82**. Sem cache, a mesma ligação custaria bem mais (a conversa inteira é reenviada a
cada resposta), e é por isso que o valor medido — e não uma estimativa — é o que vale: o
card mostra o que cada ligação custou de fato.

## Se o total em reais aparecer como "—"

A cotação ainda não foi buscada (instalação recém-feita, ou o servidor sem acesso a
`olinda.bcb.gov.br`). Para buscar na hora, de dentro da VPS:

```bash
docker compose -f docker-compose.prod.yml exec -T scheduler sh -c \
  'curl -fsS -H "Authorization: Bearer $INTERNAL_SECRET" http://app:3000/api/v1/cron/cotacao-do-dolar'
```
