---
impacto: capacidade_nova
secao: adicionado
titulo: O custo de cada ligação de voz aparece em reais em Uso de IA, convertido pela PTAX do dia
---

Cada ligação atendida pelo agente de voz passa a ter custo: no fim da chamada, o uso que a
OpenAI informa (áudio e texto, entrada, cache e saída) é multiplicado pela tarifa oficial do
modelo Realtime. Em **IA › Uso de IA**, o card **Ligações de voz** mostra o total dos últimos
30 dias em reais e em dólar, a média por ligação, o custo por minuto e as ligações mais
recentes. Cada ligação é convertida pela cotação PTAX do Banco Central do dia em que
aconteceu, buscada automaticamente todo dia. Como a ligação agora tem preço, ela também
passa a contar no orçamento mensal de IA. Nenhuma configuração nova: a cotação vem de uma API
pública do Banco Central. Detalhes em `docs/custo-das-ligacoes.md`.
