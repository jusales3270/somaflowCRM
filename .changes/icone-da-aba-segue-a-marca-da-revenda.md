---
impacto: nada_mudou
secao: corrigido
titulo: O ícone da aba acompanha a marca da revenda, e o favicon deixa de ser um arquivo fixo
---

O ícone da aba era um arquivo da distribuição que a rota `/icon` devolvia sempre:
quem trocava o nome ou o logo em **Admin › Marca** continuava mostrando o ícone
do SomaFlow na aba dos clientes dele, e `/favicon.ico` era um arquivo estático
que ignorava a marca por completo. Agora o arquivo da distribuição só aparece
enquanto a marca é a padrão (mesmo nome e nenhum logo próprio); com nome ou logo
próprios a aba mostra a cor da marca e a inicial do nome, e `/favicon.ico`
redireciona para `/icon`. Trocar só a cor continua mostrando o ícone padrão.
Nada a fazer na atualização.
