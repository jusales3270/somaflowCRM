---
impacto: nada_mudou
secao: corrigido
titulo: Telefonia — ligação de saída, porta do áudio, NAT do Asterisk e salvar o tronco sem redigitar a senha
---

Quatro defeitos da telefonia por SIP: (1) a ligação de saída de quem cadastrou o tronco pela tela
não saía — o endereço de discagem ia sem o prefixo `PJSIP/`; (2) o `.env.example` mandava o
agente de voz escutar o áudio na porta 8090, e o Asterisk disca para a 9092 — agora a porta é fixa
no compose; (3) o Asterisk da imagem não carregava o suporte a NAT (limite de módulos do PJSIP),
o que deixa registro e voz instáveis atrás do Docker; (4) salvar o tronco sem digitar a senha de
novo — o que a própria tela sugere — dava erro 500.
