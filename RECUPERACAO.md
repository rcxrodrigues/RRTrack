# Se o computador morrer

O projeto vive em três lugares, e só um deles é o computador.

| O quê | Onde vive | Sobrevive a apagar a pasta? |
|---|---|---|
| Código | GitHub `rcxrodrigues/RRTrack` (privado) | **Sim** |
| Dados (vendas, sessões, disparos) | Neon Postgres | **Sim** — nunca estiveram no computador |
| Segredos (`.env`) | Só no computador e na Vercel | **Não está no GitHub, de propósito** |

Segredo em repositório é como segredo vaza — mesmo em repositório privado, porque
basta um clone num computador emprestado, ou o repositório virar público um dia
por engano. Por isso o `.env` está no `.gitignore` e vai continuar.

## O que precisa estar guardado fora daqui

Três variáveis, no `.env` da raiz. **Copie para um gerenciador de senhas hoje**,
não para um bloco de notas na mesma pasta.

- **`CREDENTIALS_KEY`** — a mais importante, e a única sem recuperação.
- `DATABASE_URL` — recuperável no painel da Neon.
- `META_GRAPH_VERSION` — só a versão da API, sem valor secreto.

### Por que a `CREDENTIALS_KEY` não tem volta

É a chave AES que cifra, dentro do banco, tudo que é sensível:

- credenciais de gateway (chave de API do pagou.ai, da Appmax)
- credenciais de destino (token do CAPI de cada pixel, do TikTok, do Google)
- credenciais de conta de anúncio
- o comprador de cada venda (nome, e-mail, telefone, CPF, endereço, nascimento)

Perder a chave não corrompe o banco: os dados continuam lá, **ilegíveis para
sempre**. Não existe recuperação, nem por senha mestra, nem pela Neon, nem por
mim — é o ponto de cifragem funcionar.

Na prática, sem ela: reconfigurar todo gateway e todo pixel à mão, e perder o
comprador de todas as vendas já gravadas.

Hoje existem duas cópias — o `.env` local e a variável de ambiente na Vercel.
Duas cópias nos dois lugares que você pode apagar num dia ruim não é backup.

## Restaurar do zero

```bash
git clone https://github.com/rcxrodrigues/RRTrack.git
cd RRTrack
npm install
```

Recrie o `.env` com as três variáveis guardadas. Depois:

```bash
npm run typecheck && npm test
```

A suíte bate no banco e na produção. Passando, o ambiente está de pé.

O deploy não precisa de nada: a Vercel escuta o GitHub e sobe sozinha a cada
push.
