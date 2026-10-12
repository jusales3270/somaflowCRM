#!/bin/sh
# iniciar.sh — entrada do contêiner `asterisk` (docker-compose.prod.yml).
#
# Gera o manager.conf (AMI) na subida e passa a vez ao entrypoint da imagem.
#
# Por que gerar e não versionar: o usuário da AMI precisa de senha, e senha não
# vai para o repositório. Aqui ela é a MESMA da ARI (ARI_PASSWORD, já no .env),
# então ligar isto não pede nenhuma variável nova nem arquivo novo na VPS.
#
# O usuário `crm-status` só tem `write = reporting`: lê o estado do
# registro SIP (PJSIPShowRegistrationsOutbound) e mais nada — `Action: Command`
# volta "Permission denied" (medido). A porta 5038 não é publicada: só a rede
# interna do compose a alcança. Sem ARI_PASSWORD, a AMI fica desligada e a tela
# mostra só se o provedor responde.
set -eu

if [ -n "${ARI_PASSWORD:-}" ]; then
  umask 077
  cat > /etc/asterisk/manager.conf <<CONF
[general]
enabled = yes
port = 5038
bindaddr = 0.0.0.0

[crm-status]
secret = ${ARI_PASSWORD}
read =
write = reporting
CONF
else
  printf '[general]\nenabled = no\n' > /etc/asterisk/manager.conf
fi

exec /usr/local/bin/entrypoint.sh "$@"
