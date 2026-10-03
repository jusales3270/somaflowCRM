---
impacto: nada_mudou
secao: corrigido
titulo: Instalação nova mostra o logo do SomaFlow (e não o do projeto original), e o nome trocado em Admin › Marca aparece em todas as telas
---

Numa instalação nova, sem logo configurado, a barra lateral, o painel de administração
e o onboarding desenhavam o logotipo do projeto original ("Deskcomm") sob o nome do
produto. Agora a marca padrão traz o logo do SomaFlow, e a arte vetorial do projeto
original fica desligada nesta distribuição. Além disso, quem trocava o nome pela tela de
**Admin › Marca** via o nome antigo no subtítulo do login, no cadastro, nos termos legais
e no onboarding, porque essas telas liam só o `.env`; agora leem a marca resolvida (a do
banco vale mais que a do `.env`). Nos e-mails, um logo que seja caminho do próprio
servidor deixa de gerar imagem quebrada: o e-mail sai só com o nome. Nada a fazer na
atualização.
