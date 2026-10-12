---
impacto: capacidade_nova
secao: adicionado
titulo: O tronco SIP salvo na tela entra no Asterisk sozinho, e a tela mostra se o provedor aceitou o login
---

Em **Configurações › Trunk SIP**, salvar o provedor já aplica o tronco no servidor de telefonia,
sem editar `asterisk/pjsip.conf` e sem reiniciar nada. O novo card **Conexão com o provedor** diz
se o login foi aceito, recusado (senha) ou se o provedor não responde (firewall), com o próximo
passo de cada caso. Uma rotina a cada 10 minutos recoloca o tronco se o Asterisk for recriado. O
`pjsip.conf` da VPS passa a precisar só do IP público; quem já tem o tronco escrito nele continua
funcionando. Guia: `docs/telefonia-tronco-sip.md`.
