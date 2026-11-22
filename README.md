# 📚 Amigo Oculto de Livros

O organizador cria o grupo, manda o link do convite, cada pessoa se cadastra com os livros que gostaria de ganhar e o organizador faz o sorteio. **Cada participante vê só quem tirou** — nem o organizador vê os pares.

- **Organizador** (`#/admin/<grupo>`): link do convite (com botão de WhatsApp), lista de participantes, remover alguém, editar regras/data/valor, **sortear** (mínimo 3) e desfazer o sorteio se precisar incluir alguém atrasado.
- **Participante** (`#/g/<grupo>` → `#/me/<membro>`): entra com nome e lista de desejos, edita a lista quando quiser (quem o tirou vê a versão mais recente), e depois do sorteio abre o "livro" para ver quem tirou e o que a pessoa quer ganhar.
- O sorteio forma um único ciclo aleatório (ninguém tira a si mesmo, nem há pares fechados de dois).
- Acesso sem login: o navegador gera uma chave secreta para o organizador e para cada participante (o banco só guarda o hash). O **link pessoal** e o **link de organizador** levam a chave para abrir em outro aparelho.
- Atualiza ao vivo (Realtime Broadcast, canal `ao-<grupo>`), com recarga a cada 20 s como reserva.

## Deploy: GitHub Pages + Supabase (igual ao Rolê de Slides)

Site estático (`index.html` + `app.js`); o workflow gera `config.js` com as variáveis do repositório.
Os dados ficam no schema privado `ao` do Supabase, fora da API REST (RLS ligado, sem políticas); o front só usa a chave pública (`anon`) e chama as funções RPC `ao_*` (`security definer`), que conferem as chaves e limitam abusos por IP.

1. No **SQL Editor** do projeto Supabase, rode os arquivos de `supabase/migrations/` em ordem (são idempotentes).
2. Variáveis do repositório (*Settings → Secrets and variables → Actions → Variables*): `SUPABASE_URL` e `SUPABASE_ANON_KEY`.
3. *Settings → Pages → Source: GitHub Actions*. Todo push na `main` publica.

Sem as variáveis, o site roda em **modo local** (dados só no navegador; bom para testar).

## Rodando local

```bash
npx serve .    # ou: python -m http.server
```
