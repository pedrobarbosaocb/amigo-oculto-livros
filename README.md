# 📚 Amigo Oculto de Livros

O organizador cria o grupo, manda o link do convite, cada pessoa se cadastra com os livros que gostaria de ganhar e o organizador faz o sorteio. **Cada participante vê só quem tirou** — nem o organizador vê os pares.

- **Organizador** (`#/admin/<grupo>`): link do convite (com botão de WhatsApp), lista de participantes, remover alguém, editar regras/data/valor, **sortear** (mínimo 3) e desfazer o sorteio se precisar incluir alguém atrasado.
- **Participante** (`#/g/<grupo>` → `#/me/<membro>`): entra com nome e lista de desejos, edita a lista quando quiser (quem o tirou vê a versão mais recente), e depois do sorteio abre o "livro" para ver quem tirou e o que a pessoa quer ganhar.
- O sorteio forma um único ciclo aleatório (ninguém tira a si mesmo, nem há pares fechados de dois).
- Acesso sem login: o navegador gera uma chave secreta para o organizador e para cada participante (o banco só guarda o hash). O **link pessoal** e o **link de organizador** levam a chave para abrir em outro aparelho.
- Atualiza ao vivo (Realtime Broadcast, canal `ao-<grupo>`), com recarga a cada 20 s como reserva.

## Deploy: Railway (front) + Supabase (banco)

O front é estático (`index.html` + `app.js`) servido por um `server.js` em Node puro, sem dependências, que gera o `config.js` a partir das variáveis de ambiente.
Os dados ficam no schema privado `ao` do Supabase, fora da API REST (RLS ligado, sem políticas). O front só usa a chave pública (`anon`) e chama as funções RPC `ao_*` (`security definer`), que conferem as chaves e limitam abusos por IP.

1. No **SQL Editor** do projeto Supabase, rode os arquivos de `supabase/migrations/` em ordem (são idempotentes).
2. No Railway: *New Project → Deploy from GitHub repo* → este repositório. O Railway detecta o `package.json` e roda `npm start`.
3. Variáveis do serviço no Railway: `SUPABASE_URL` e `SUPABASE_ANON_KEY`. Depois, em *Settings → Networking → Generate Domain*.
4. Todo push na `main` publica de novo.

Sem as variáveis, o site roda em **modo local** (dados só no navegador; bom para testar).

## Rodando local

```bash
npm start      # http://localhost:3000 (modo local sem as variáveis)
```
