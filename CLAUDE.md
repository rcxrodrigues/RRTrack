# RRTrack — o que saber antes de mexer

Rastreamento server-side: o navegador manda evento para cá, o gateway manda a
venda por webhook, e daqui sai conversão para Meta, Google Ads e TikTok — com o
gasto vindo de volta para fechar ROAS.

`README.md` explica o produto e as variáveis de ambiente. `RECUPERACAO.md`
explica como levantar tudo do zero. Este arquivo é o resto: o que já foi
decidido, e o que quebra quando se decide diferente.

## Comandos

```bash
npm run typecheck      # tsc --noEmit — rode SEMPRE antes de commitar
npm test               # tudo: 21 unitários (14 sem banco + 7 com) + 6 de ponta a ponta
npm run test:sem-banco # só o que dispensa .env — serve em clone novo
npm run build          # o build da Vercel, rodando aqui
npm run dev            # localhost:3000
```

`npm test` precisa de `DATABASE_URL` e `CREDENTIALS_KEY` no `.env`. Sem eles, 13
testes não rodam e a saída **diz isso em vez de mentir que passou** — foi feita
assim de propósito.

Os de ponta a ponta rodam contra **esta máquina** (`npm run dev` em outro
terminal). Mirar outro endereço exige `npm test -- --remoto`, e isso é proteção,
não burocracia: eles gravam lojas de teste no banco e disparam webhook no alvo.
O padrão já foi produção, e o estrago não foi o que se espera — a semente é
cifrada com a `CREDENTIALS_KEY` LOCAL, a produção decifra com a DELA, e todas as
defesas de assinatura falharam em cascata. O relatório parecia buraco de
segurança em produção; era o teste escrevendo onde não sabia ler.

Use `npm ci`, não `npm install`. O `install` reescreve o `package-lock.json` em
versões diferentes do npm e o conflito trava o `git pull` de quem vier depois.

## As sete regras que o código inteiro assume

1. **`tenantId` em toda tabela de negócio, e prefixando todo índice.** Multi-loja
   desde a origem. Consulta sem `where tenantId` é vazamento entre clientes.

2. **Dinheiro é inteiro, na menor unidade da moeda** (`grossCents`, `spendCents`).
   Nunca `float`. E **moeda junto do valor**: somar conta em dólar com loja em
   libra dá um ROAS sem significado, e sem erro nenhum aparecendo.

3. **O formato canônico é a fronteira** (`src/core/types.ts`). Gateway traduz para
   dentro, destino traduz para fora, e **nenhum campo específico de gateway
   atravessa**. Se `src/core` precisa saber que existe Appmax, o desenho quebrou.

4. **`clickId` é a chave que atravessa o checkout**, não o cookie — cookie não
   sobrevive ao pulo para o domínio do gateway.

5. **Deduplicação é índice único no banco**, nunca trava em memória: em
   serverless o processo morre entre requisições e a trava morre junto.

6. **Erro transitório se reenfileira; payload recusado, não.** Insistir em
   payload errado só gasta cota que faria falta ao que tem conserto.

7. **Credencial nunca em texto claro.** `src/core/crypto.ts` cifra com AES-256-GCM
   antes de gravar. A chave vive no ambiente e **o banco nunca a vê** — é por isso
   que aqui não se usa `pgcrypto`.

## Onde cada coisa mora

```
src/core/        regras do negócio, sem saber de HTTP nem de plataforma
src/gateways/    Appmax, pagou.ai, Shopify, Millions, genérico (Hotmart/Kiwify/Eduzz)
src/destinations/ para onde a conversão vai: meta, google (Ads), tiktok
src/ads/         de onde o gasto vem: as mesmas três, do outro lado
src/db/schema.ts as 19 tabelas
src/ui/          componentes do painel
app/api/         rotas
public/rr.js     o script que roda no site do cliente
scripts/         testes e utilitários de operação
```

Destino novo é **um arquivo em `src/destinations/`** mais uma linha no
`registry.ts`. Nada mais no sistema muda. Se estiver mudando mais, pare e olhe
de novo.

## Versões de API externa

**Uma constante, em `src/core/versoes.ts`.** Não espalhe.

A Meta e o Google põem a versão **na URL**, então uma versão morta é 404 em toda
chamada — e o erro não diz "versão", diz que o recurso não existe, e manda
investigar o pixel errado. `scripts/teste-versoes.mjs` tem uma guarda que
reprova o commit se algum adaptador voltar a montar a URL da Meta à mão.

Depois de trocar uma versão, **clique em "Testar conexão"** na tela de
Integrações. Ele faz leitura real e mostra a resposta da plataforma. Subir
versão sem clicar é apostar.

## O que já foi tentado e não funciona

- **`??` para ler variável de ambiente.** Não cai no padrão quando a variável
  existe vazia — que é como o `.env.example` a apresenta e como a Vercel devolve
  um campo limpo. Use `versao()` de `core/versoes.ts`.
- **Guardar estado de OAuth em cookie.** Falha calada quando o consentimento
  acontece em outro navegador, que é o caso de quem usa antidetect. Por isso
  existe a tabela `meta_links`.
- **Avisar sobre moeda em vez de gravá-la.** A linha entrava sem moeda e virava
  número puro na soma. Hoje `ad_spend_daily.currency` é obrigatória.
- **Teste apontando para fora da suíte.** `teste-ads-meta` viveu em `/tmp` e
  apodreceu: quando foi reconectado, estava exigindo uma regra removida havia
  meses. Teste que ninguém roda não protege nada.
- **Reimportar módulo com query para furar cache, nos testes.** A suíte compila
  para CommonJS, cujo cache ignora a query. O teste passa sem testar nada.
  Exporte a função pura e teste ela.
- **Deixar a suíte de ponta a ponta mirar produção por padrão.** Ver acima.
- **Definir na Vercel uma variável que o código já resolve.** `META_GRAPH_VERSION`
  ficou lá esquecida e anulava em silêncio a constante de `core/versoes.ts` —
  o repositório dizia v26.0 e produção rodava outra coisa. Essas variáveis são
  para testar versão nova SEM subir código; passado o teste, apague.
- **Credencial ilegível ser tratada como "gateway não assina".** Em
  `core/receber.ts`, chave de cifragem incompatível faz a verificação de
  assinatura deixar de acontecer, e o webhook é aceito com 200. Está assim
  ainda; o diagnóstico é `npm run conferir:credenciais`.

## Buracos conhecidos, de propósito

- **Sem RLS.** O isolamento é por `tenantId` no código, que vale até alguém
  esquecer um `where`.
- **Sem rate limiting** em `/api/collect` e `/api/webhook/[gateway]/[secret]`,
  que são públicos.
- **Sem retenção**: `dispatches.request_body` e `webhook_deliveries.raw_body`
  crescem para sempre.
- **Sem GA4.** `src/destinations/google.ts` é Google **Ads**.
- **Google Ads na v21**, deliberadamente atrás — versão maior lá quebra de
  verdade. O comentário em `core/versoes.ts` diz o que conferir antes de subir.
- **Seis avisos do `npm audit` que ficam.** O README explica um a um por que
  nenhum tem caminho de entrada, e qual condição faria revisitar.

## O coletor de primeira parte

O snippet pode carregar de um subdomínio da própria loja (`t.loja.com.br`) em
vez do domínio do RRTrack. Vale por duas coisas: bloqueador de anúncio deixa de
ter nome para casar, e o cookie do clickId para de morrer em 24 h no Safari.

**São duas metades, e uma sem a outra não vale nada.** O limite do Safari é do
cookie escrito por SCRIPT, não do script — então trocar o endereço do snippet
sozinho não resolveria. O que levanta o limite é `Set-Cookie` numa resposta do
mesmo site, e é por isso que `/api/collect` devolve `_rr_cid` e `_rr_eid`, e que
`rr.js` **para de reescrevê-los** quando o coletor é do mesmo site.

**O snippet só migra depois de VERIFICADO.** `collector_host` nasce como palpite
(`"t." + domínio`) no cadastro da loja, antes de existir DNS. Apontar o snippet
para ele na hora não pioraria a coleta: mataria a coleta, e a tela continuaria
verde porque do lado de cá nada dá erro quando nada chega. Por isso existe
`collector_verified_at`, gravado só quando `/api/integracoes/coletor` busca o
script E o endpoint no endereço e os dois respondem. Falha **zera** a data, e o
snippet volta sozinho para o domínio do RRTrack.

**Some, não substitui.** O domínio do RRTrack continua servindo webhook (e,
enquanto durar a migração, painel). As URLs de webhook estão cadastradas nos painéis dos gateways; trocá-las
faria as vendas pararem de chegar sem erro nenhum aparecer.

A lista de sufixo público está **duplicada** em `public/rr.js`,
`app/api/collect/route.ts` e `app/api/integracoes/coletor/route.ts`, porque o
primeiro é servido estático e não importa de `src/`. Quando as duas primeiras
divergiram, o servidor mandava `Domain=.me.uk`, o navegador recusava por ser
sufixo público, e o cookie não existia para aquelas lojas — calado.
`scripts/teste-coletor.mjs` compara as listas e reprova se saírem do ar.

## Estilo

Comentário explica **por quê**, não o quê — e principalmente o que aconteceu
quando se fez diferente. Código e comentário em **português**. Nome de variável
em português quando é do negócio (`gastoCents`, `bloqueadoAte`), em inglês
quando é da plataforma (`externalId`, `eventId`).

Comentário longo não é enfeite: quase todo comentário grande aqui é a lápide de
um defeito que custou caro. Ao mudar o código que ele descreve, **atualize-o** —
comentário que virou mentira é pior que comentário nenhum.

## Para onde os painéis vão

Decisão do dono, setembro de 2026: **o domínio do RRTrack deixa de hospedar
painel.** Cada oferta passa a ter o dela num subdomínio próprio
(`track.transforlar.com` e afins). Clonagem de configuração entre ofertas fica
para estudo posterior.

**Isso já funciona sem código nenhum.** Todo domínio apontado para o projeto na
Vercel serve o mesmo app, então `track.<oferta>/integracoes` abre o painel hoje.

**O que NÃO se move junto** são três URLs que vivem cadastradas em painéis de
TERCEIROS, e todas saem de `RR_BASE`:

| URL | Cadastrada em |
|---|---|
| `${base}/api/webhook/<gateway>/<segredo>` | painel de cada gateway |
| `${base}/api/pedidos` | checkout da loja |
| `${base}/api/meta/retorno` | URIs de redirecionamento do app no Facebook |

Enquanto o domínio do RRTrack responder, as três funcionam — mesmo que ninguém
nunca mais abra o painel por ele. **Desligar o domínio é outra conversa**: cada
uma precisa migrar com janela de sobreposição, e webhook não avisa quando para
de chegar. O gateway tenta, falha e desiste, em silêncio.

E há um item de trabalho de verdade escondido aqui: `RR_BASE` é **uma variável,
um valor**. Para a URL de webhook sair no domínio de cada oferta, ela precisa
virar coluna por site. Enquanto não for, o painel mostra a mesma base para
todas as lojas — o que está certo hoje e deixa de estar no dia da migração.

## Uma oferta nova, do zero

O sistema é multi-loja desde a origem: **cada oferta é um tenant**, com site,
gateways, pixels e contas de anúncio próprios, isolados por `tenantId` em toda
consulta. O seletor no topo do painel troca entre elas. **Não se duplica nada** —
nem deploy, nem banco, nem projeto na Vercel.

O roteiro é sempre o mesmo, e a ordem importa em dois pontos:

1. **Cadastrar a loja e o site** (`npm run cadastrar`, ou pelo painel). Guarde o
   domínio LIMPO: `loja.com.br`, não `https://loja.com.br/`. Os dois formatos
   funcionam — `core/dominio.ts` normaliza na leitura — mas o segundo já custou
   duas falhas silenciosas, então não crie mais.

2. **DNS**: `CNAME track` → o valor que a **Vercel** mostrar ao adicionar o
   domínio. Ele identifica o projeto, então é o mesmo para todas as ofertas.
   Na Cloudflare, **DNS only** (nuvem cinza): proxiando, a Vercel não valida o
   domínio, o certificado não sai, e o navegador entra em laço de
   redirecionamento — nenhum dos dois sintomas diz "proxy ligado".

3. **Vercel** → Domains → `track.<dominio>`, em **Production**. Preview segue um
   branch, e no dia em que o branch morrer a coleta morre junto.

4. **Verificar** no cartão "Coletor no seu domínio", na tela de Integrações, com
   a loja certa selecionada. Só depois disso o snippet migra.

5. **Copiar o snippet** — ele muda depois da verificação — e colar no `<head>`.

6. **Gateway, pixel e conta de anúncio**, cada um com "Testar conexão" clicado.
   Credencial errada não dá erro em lugar nenhum; o botão é a única prova.

7. **Registrar a URL do webhook** no painel da plataforma de vendas. É o passo
   que mais se esquece, e o sintoma é venda que nunca chega, sem erro.
