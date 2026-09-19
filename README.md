# RRTrack

Plataforma própria de rastreamento e atribuição. Mede gasto, faturamento, lucro e ROAS
— e, com os mesmos dados, alimenta Meta, Google e TikTok com sinal melhor do que o
navegador sozinho consegue entregar.

Sem GTM. Sem Stape. Sem GA4.

## O problema que ele resolve

O navegador sabe de onde a pessoa veio: campanha, criativo, `fbclid`, IP. Não sabe quem
ela é. O gateway sabe exatamente quem comprou — nome, e-mail, telefone, valor real — e
não faz ideia de qual anúncio trouxe essa pessoa.

O RRTrack é a máquina que costura essas duas metades. Um `clickId` nasce no navegador,
atravessa o checkout e volta no webhook. É por ele, e não por cookie, que a venda
reencontra o anúncio — cookie não sobrevive ao pulo para o domínio do gateway.

E é daí que sai o ganho de correspondência na Meta: e-mail e telefone do comprador só
existem dentro do gateway, e só saem pelo webhook.

## Arquitetura

```
navegador (rr.js) ──sck/metadata/claim──> checkout do gateway
       │                                          │
       └── POST /rr/collect                       └── POST /api/webhook/:gateway/:segredo
                    │                                          │
              click_sessions ◄────── junção pelo clickId ──────┘
                    │
                    └──> Meta CAPI · Google Ads · TikTok
```

Formato canônico no meio. De um lado, adaptadores traduzem o dialeto de cada gateway
para ele; do outro, traduzem dele para cada plataforma de anúncio. Nenhum campo
específico de gateway atravessa essa fronteira.

## Gateways

| Gateway | Chaves de correspondência | Como o clickId chega | Assinatura |
|---|---|---|---|
| MillionsPay | 10 | `metadata` | HMAC-SHA256 |
| Pagou.ai | 9 | `sck` | nenhuma |
| Appmax | 9 com API, 5 sem | reivindicação | nenhuma |

Plugar um gateway novo é escrever um arquivo em `src/gateways/` e acrescentar uma linha
em `registry.ts`. Nada fora dessa pasta muda.

## Estrutura

```
src/core/        formato canônico, normalização de PII, identidade, junção, disparo
src/db/          schema multi-loja e conexão
src/gateways/    um arquivo por gateway
src/destinations/ um arquivo por plataforma de anúncio
app/api/         coletor, roteador de webhook, reivindicação
public/rr.js     o snippet de primeira parte
scripts/         seed e testes
```

## Rodando

```bash
npm install
cp .env.example .env    # preencher DATABASE_URL e CREDENTIALS_KEY
npm run db:push
npm run dev
```

Gerar a chave de cifragem das credenciais:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## Testes

Precisam do servidor rodando e do banco acessível.

```bash
npm run seed                       # cria loja de teste, devolve as chaves
node scripts/teste-e2e.mjs '<json do seed>'
node scripts/teste-gateways.mjs '<json do seed>'
```

O disparo para a Meta usa token falso no teste e responde `HTTP 401` — o que prova que a
requisição chegou ao `graph.facebook.com` e foi recusada por credencial, não por payload.

## Variáveis de ambiente

| Variável | Para quê |
|---|---|
| `DATABASE_URL` | Postgres (Neon), com `?sslmode=require` |
| `CREDENTIALS_KEY` | 32 bytes em base64; cifra as credenciais guardadas no banco |
| `META_GRAPH_VERSION` | sobrepõe a versão da Meta; vazio usa o padrão de `src/core/versoes.ts` |
| `GOOGLE_ADS_VERSION` | sobrepõe a versão do Google Ads; mesmo arquivo |

Nenhuma delas vai para o git. Em produção vivem nas variáveis de ambiente da Vercel.

## O que o `npm audit` acusa, e por quê fica

Seis avisos permanecem, e nenhum é alcançável nesta instalação. Ficam
registrados aqui para ninguém refazer a investigação.

**Quatro são da cadeia `esbuild` → `@esbuild-kit` → `drizzle-kit`.** Não têm
correção: o `drizzle-kit@0.31.10`, que o próprio `npm audit` indica como a
solução, continua dependendo do `@esbuild-kit/esm-loader@2.6.5`. A falha é o
servidor de desenvolvimento do esbuild aceitar requisição de qualquer site — e
o drizzle-kit usa esbuild só para transpilar o arquivo de configuração, sem
subir servidor nenhum. **Revisar quando o drizzle-kit largar essa dependência.**

**Duas são `postcss` e o `next` que depende dela.** XSS na escrita de CSS. O
CSS deste projeto é um arquivo estático escrito à mão; nada de fora passa pelo
PostCSS. Fechá-las exigiria subir o Next uma versão maior — risco de quebrar o
que funciona para resolver o que não atinge. **Revisar quando houver outro
motivo para subir o Next.**

O que **foi** corrigido, porque era real: a execução remota de código do Next
(crítica, embora só em servidor Windows, e o deploy é Linux) e a injeção de SQL
do drizzle-orm. Esta última também não era alcançável — os três `sql.raw` do
projeto usam só constantes — mas é dependência de produção, e aí o critério é
outro.

A regra ao avaliar um aviso novo: **pergunte por onde entrada de usuário
chegaria até ele.** Se não houver caminho, anote aqui em vez de subir versão.

## Decisões que não são óbvias

**Dinheiro é sempre inteiro em centavos.** Ponto flutuante em faturamento acumula erro
que aparece no fechamento do mês.

**Fuso por loja, não global.** "Horário das vendas" e o corte do dia só fazem sentido no
fuso de quem vende, e gasto importado em UTC vaza para o dia errado.

**Custo de produto tem vigência.** O custo muda; o histórico não pode mudar junto, senão
o lucro do mês passado se reescreve sozinho.

**Como a venda foi atribuída fica gravado.** `click_id` é certeza, `fbp_match` é palpite.
Número atribuído por palpite não vale o mesmo, e o painel precisa poder mostrar isso.

**Deduplicação é no banco, não em memória.** Trava em memória não sobrevive entre funções
serverless, e é justamente sob carga que a reentrega acontece.

**O beacon vai como `text/plain`.** `application/json` exigiria verificação prévia de
CORS, que o `sendBeacon` não sabe fazer — a requisição não sairia.
