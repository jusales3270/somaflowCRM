# Telefonia: o tronco SIP pela tela

Para quem instala e opera a telefonia (ligações de verdade, com o agente de voz atendendo).

## O que mudou

Antes, o tronco do provedor SIP era digitado duas vezes: na tela **Configurações › Trunk SIP**
e, à mão, no `asterisk/pjsip.conf` da VPS. Agora **salvar na tela já aplica o tronco no Asterisk**,
na hora, sem editar arquivo e sem reiniciar nada. A tela mostra se o provedor aceitou o login.

## Ligar a telefonia na VPS (uma vez)

1. Copie `asterisk/pjsip.conf.example` para `asterisk/pjsip.conf` e troque `SEU_IP_PUBLICO` pelo IP
   público da VPS. É só isso que esse arquivo precisa ter.
2. Copie `asterisk/ari.conf.example` para `asterisk/ari.conf` e ponha uma senha forte. Use **a mesma**
   em `ARI_PASSWORD` no `.env` (e o usuário em `ARI_USERNAME`).
3. No `.env`, ponha `telefonia` em `COMPOSE_PROFILES` (ex.: `COMPOSE_PROFILES=telefonia`).
4. Libere no firewall da VPS a porta **UDP 5060** e a faixa **UDP 10000–10200**.
5. Suba: `docker compose -f docker-compose.prod.yml --env-file .env up -d`.

## Cadastrar o provedor

Em **Configurações › Trunk SIP** (administrador da organização): host, porta, usuário e senha do
provedor. Ao salvar, o card **Conexão com o provedor** diz o estado:

| Estado | O que fazer |
|---|---|
| Conectado | Nada. Ligações entram e saem por este tronco. |
| Conectando | Aguarde alguns segundos; a tela confere de novo sozinha. |
| O provedor recusou o login | Confira usuário e senha com o provedor, corrija e salve. |
| O provedor não responde | Confira host e porta; libere UDP 5060 e 10000–10200 no firewall. |
| Salvo, ainda não aplicado | O Asterisk estava fora na hora; aplica sozinho em até 10 minutos. |
| Telefonia desligada nesta instalação | Siga "Ligar a telefonia na VPS" acima. |

Para trocar só o host ou desativar o tronco, **não é preciso redigitar a senha**.

## Como funciona por dentro

- `asterisk/sorcery.conf`: o PJSIP lê os objetos do tronco do arquivo **e** do astdb (banco interno do
  Asterisk, no volume `asterisk-data`). A tela grava no astdb pela ARI
  (`lib/voip/tronco-no-asterisk.ts`). O arquivo é lido antes: quem escreveu o tronco à mão continua
  funcionando.
- `asterisk/iniciar.sh`: na subida do contêiner, gera um usuário da AMI que **só lê estado**
  (`write = reporting`), com a senha da ARI. É por ele que a tela sabe se o provedor aceitou o login.
  A porta 5038 não é publicada.
- `asterisk/modules.conf`: desliga módulos PJSIP sem uso. Sem isso, o Asterisk da imagem estourava o
  limite de módulos do pjproject e o suporte a NAT (`res_pjsip_nat`) não carregava.
- Cron `voip-tronco` (a cada 10 minutos): recoloca no Asterisk o tronco que sumiu (contêiner recriado,
  telefonia ligada depois) e tira o desativado. Tronco que já está lá não é reaplicado.

Nomes dos objetos no Asterisk: `org-<id da organização>-trunk-{endpoint,auth,aor,identify,reg}`.

## Limites conhecidos

- O host do provedor precisa ser resolvível pelo DNS da VPS (nome público ou IP).
- Provedor que autentica só por IP, sem registro, ainda não tem opção na tela.
