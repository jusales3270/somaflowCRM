---
impacto: nada_mudou
secao: corrigido
titulo: Admin › Marca volta a salvar quando o logo da instalação é um caminho do próprio servidor
---

Numa instalação semeada com `APP_LOGO_URL="/logo.png"` (o valor do `.env.example`),
qualquer salvamento em **Admin › Marca** era recusado com "Confira os campos: algum
valor não está no formato esperado" — até trocar só o nome ou a cor —, porque o
formulário devolve o logo gravado como está e a validação exigia uma URL completa.
Agora o logo pode ser uma URL completa ou um caminho que comece por `/`
(`//servidor` continua recusado). Nada a fazer na atualização.
