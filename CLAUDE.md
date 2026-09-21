# RRTrack — o que saber antes de mexer

Rastreamento server-side: o navegador manda evento para cá, o gateway manda a
venda por webhook, e daqui sai conversão para Meta, Google Ads, TikTok e GA4 — com
o gasto vindo de volta para fechar ROAS.

`README.md` explica o produto e as variáveis de ambiente. `RECUPERACAO.md`
explica como levantar tudo do zero. Este arquivo é o resto: o que já foi
decidido, e o que quebra quando se decide diferente.

## Comandos

```bash
npm run typecheck      # tsc --noEmit — rode SEMPRE antes de commitar
npm test               # tudo: 25 unitários (18 sem banco + 7 com) + 6 de ponta a ponta
npm run test:sem-banco # só o que dispensa .env — serve em clone novo
npm run build          # o build da Vercel, rodando aqui
npm run dev            # localhost:3000
```

`npm test` precisa de `DATABASE_URL` e `CREDENTIALS_KEY` no `.env`. Sem eles, 13
testes não rodam e a saída **diz isso em vez de mentir que passou** — foi feita
assim de propósito.

**`DATABASE_URL_TESTE` no `.env` manda a suíte inteira para outro banco** — no
Neon, um branch, que sai em segundos e não duplica dado. Vazio, ela usa o
`DATABASE_URL` normal e **avisa, dizendo o host**, antes de escrever nele. Vale
a pena preencher: a semente cria loja, conexão e destino, e os de ponta a ponta
gravam venda; a limpeza do fim só roda se a suíte chegar ao fim.

Os de ponta a ponta rodam contra **esta máquina** (`npm run dev` em outro
terminal). Mirar outro endereço exige `npm test -- --remoto`, e isso é proteção,
não burocracia: eles gravam lojas de teste no banco e disparam webhook no alvo.
(O `--remoto` cuida do ENDEREÇO; do banco cuida o `DATABASE_URL_TESTE` acima —
são as duas metades do mesmo estrago.)
O padrão já foi produção, e o estrago não foi o que se espera — a semente é
cifrada com a `CREDENTIALS_KEY` LOCAL, a produção decifra com a DELA, e todas as
defesas de assinatura falharam em cascata. O relatório parecia buraco de
segurança em produção; era o teste escrevendo onde não sabia ler.

## Ferramentas de operação

Rodadas à mão, não pela suíte. Ficaram anos sem aparecer em lugar nenhum e por
isso quase foram apagadas numa faxina — estão aqui para serem encontradas.

```bash
npm run usuario         # cria pessoa e dá acesso. NÃO há tela de convite:
                        # a primeira conta de qualquer sistema nasce fora dele
npm run redes:meta      # regera as faixas de IP da Meta (AS32934, via RIPE)
                        # para o filtro de robô. Rodar a cada poucos meses
npm run teste:purchase  # encena uma venda contra o pixel REAL usando
                        # test_event_code. Roda ANTES de ligar tráfego: o
                        # purchase só nasce de webhook, e descobrir que a Meta
                        # recusa o payload na primeira venda de verdade é caro
npm run conferir:credenciais   # a CREDENTIALS_KEY do .env abre o que está no banco?
npm run faxina                 # mostra o que há de cadastro abandonado (--aplicar executa)
```

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
src/destinations/ para onde a conversão vai: meta, google (Ads), tiktok, ga4
src/ads/         de onde o gasto vem: meta, google, tiktok — do outro lado
                 (o GA4 não tem gasto: ele recebe conversão e não vende anúncio)
src/db/schema.ts as 20 tabelas
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
  `core/receber.ts` havia um `catch` vazio: sem credencial, `verify` devolve
  `sem_assinatura` — o MESMO sinal de um gateway que genuinamente não assina —
  e a venda entrava com 200, marcada como não verificada. Chave de cifragem
  incompatível DESLIGAVA a verificação de assinatura, em silêncio, para todos
  os gateways de uma vez. **Corrigido**: agora é 500, e não 401 — 401 acusaria
  quem assinou certo, e gateway não repete 401, então a venda sumiria por
  defeito nosso. 5xx entra na fila de reentrega. Diagnóstico da causa:
  `npm run conferir:credenciais`.
- **Provar o `rr.js` por expressão regular sobre o código-fonte.** Prova que a
  linha está escrita, não que ela funciona. `scripts/dom-falso.cjs` monta um
  navegador mínimo e RODA o arquivo que a Vercel serve; `teste-ga4` e
  `teste-produto-pagina` passam por ele. Regex continua valendo para o que não
  dá para rodar aqui — o que uma rota do servidor contém, por exemplo.

## Buracos conhecidos, de propósito

- **Sem RLS.** O isolamento é por `tenantId` no código. O plano continua de pé,
  mas o caminho é mais caro do que parecia e está medido em `teste-isolamento`:
  `db.transaction()` **lança erro** no driver HTTP do Neon, e `SET LOCAL` não
  cola porque ele não mantém conexão entre statements. O que existe é
  `db.batch()`, que manda tudo num pedido HTTP dentro de uma transação — então
  cada uma das **77 consultas** a tabela de negócio viraria um batch com
  `set_config('app.tenant_id', …, true)` na frente. Enquanto isso não acontece,
  a proteção é em tempo de COMMIT: `scripts/teste-isolamento.mjs` reprova
  qualquer consulta nova que não filtre por `tenantId`, não aja por chave
  primária, nem busque por coluna com índice único global.
- **`src/destinations/google.ts` é Google Ads**, não Analytics. O GA4 é
  `ga4.ts`, ao lado — nomes parecidos, APIs sem nada em comum.
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

## Os endpoints públicos: contenção e retenção

`/api/collect` e `/api/webhook/<gateway>/<segredo>` são abertos para a internet
inteira, sem credencial. `src/core/contencao.ts` conta quem chega.

**Os tetos erram para o lado do cliente, e isso é o desenho.** Beacon barrado é
atribuição perdida em silêncio; webhook barrado é venda que não entra. Então os
números são folgados (600/min por IP, 6.000/min por loja, 600/min por conexão),
o estouro responde **429 com `Retry-After`** — o único 4xx que gateway trata
como transitório e reentrega — e **falha ABERTO**: contagem que não pôde ser
feita deixa passar.

**Janela FIXA, não deslizante**, e a diferença é assumida: deslizante exigiria
um carimbo por requisição, mais escrita no caminho mais quente. O custo é o
dobro do teto na virada, que para teto de abuso não muda nada.

**Não custa uma ida a mais ao banco**: `db.batch()` manda os contadores junto
da busca do site. É também o único caminho transacional que existe aqui —
`db.transaction()` lança "No transactions support" no driver HTTP do Neon.

**Retenção** (`src/core/retencao.ts`, Vercel Cron às 4:17 UTC via `vercel.json`)
**zera o corpo, não apaga a linha**: data, evento, status e chaves de
correspondência ficam. Duas coisas que ela NUNCA pode zerar, e as duas
custariam caro:

- disparo com `next_attempt_at` marcado está **na fila de reenvio**, e o reenvio
  reconstrói o pedido a partir do `request_body` guardado;
- `raw_body` é `NOT NULL` — UPDATE para NULL estoura a restrição e derruba a
  rotina inteira. Vai para string vazia.

A rota precisa de `CRON_SECRET` no ambiente; **sem ela, a porta do cron não
existe** (comparar contra variável vazia deixaria "Bearer undefined" entrar).
`?conferir=1` diz quanto de corpo velho ainda sobrou — a resposta honesta para
"a rotina está dando conta?".

## As chaves que descobrem a loja sozinhas

`sites.public_key` e `gateway_connections.webhook_secret` são buscados **sem
`tenantId`**, porque o tenant é justamente o que eles respondem. Isso só é
seguro com **índice único** — sem ele, duas linhas com o mesmo valor fazem o
`limit(1)` escolher uma, e o evento (ou a VENDA) entra na loja errada, sem erro.

Não era colisão aleatória que preocupava: são 96 bits. Era não haver nada
IMPEDINDO a duplicata — `regerar_chave` não conferia, uma restauração pode
repetir, e **clonar a configuração de uma oferta para outra, que é o plano,
copiaria a chave junto**. A migração `0006` põe os dois índices; `npm run faxina`
avisa se já houver duplicata, porque criar índice único em cima de uma FALHA e
a mensagem do Postgres não diz quais linhas são.

## O GA4, e as duas portas que não se substituem

**`gtag.js` manda o que acontece na página. O Measurement Protocol manda o que
não acontece na página — que é um evento só: a compra.**

Ela nasce quando o gateway avisa que alguém pagou, horas depois de o navegador
ter fechado, e por isso é a única que o servidor tem para contar. Todo o resto
do funil o navegador já viu.

**Mandar qualquer evento pelos dois faz o GA4 contar os dois.** A receita dobra,
a taxa de conversão cai pela metade, e não há erro em lugar nenhum — só um
número que parou de bater com a realidade. Por isso `supports` em
`src/destinations/ga4.ts` tem **um item**, e o mapa `GA4` em `public/rr.js`
**não tem `purchase`**. Acrescentar um evento de um lado exige responder antes
"e o outro lado para de mandar esse?". `scripts/teste-ga4.mjs` roda o `rr.js` de
verdade e reprova se a compra voltar ao navegador.

E não é só duplicação: compra disparada no navegador conta venda que o gateway
ainda vai recusar — pix não pago, cartão negado.

**O gtag é carregado pelo `rr.js`, a partir da configuração.** O measurement id
sai da linha de `destinations` e entra no snippet; nunca escrito no código.
Duas coisas que o carregamento faz e que parecem detalhe:

- `send_page_view: false` no `config` — senão o GA4 dispara um page_view sozinho
  e o `rr.js` dispara o dele: dois por carregamento. O nosso vai porque também
  cobre navegação por JavaScript, que o gtag sozinho não enxerga.
- **Sai da frente inteiro se a página já tiver `gtag` ou `dataLayer`.** Duas
  instalações contam tudo em dobro, e o sintoma é um relatório plausível. Quem
  tem GTM quase sempre configura o GA4 por dentro dele.

**O `client_id` é LIDO do cookie `_ga`, nunca gerado** — ao contrário do `_fbp`,
que nós criamos porque sem o pixel da Meta ele não existiria. Inventar um aqui
criaria um usuário novo a cada compra: a taxa de conversão iria ao teto e a
origem do tráfego se perderia, porque quem tinha a origem era a sessão do
navegador. Sem ele o adaptador **recusa o envio**, com o motivo na tela.

O cookie só existe depois que o gtag carrega, então o primeiro beacon sai sem
ele — daí o `COALESCE` em `/api/collect` e o pulso extra que o `rr.js` manda
quando o `_ga` aparece.

**`G-XXXXXXXXXX`, não o ID do fluxo.** Os dois ficam na mesma tela do Google. O
Measurement Protocol responde **204 para qualquer coisa**, inclusive para
measurement id inexistente e api_secret errado — então id trocado não dá erro
em lugar nenhum, e nenhum evento aparece. Por isso a rota confere o formato ao
gravar, e por isso "Testar conexão" usa `/debug/mp/collect`, que é o único
endpoint que valida (e não registra nada).

## Estilo

Comentário explica **por quê**, não o quê — e principalmente o que aconteceu
quando se fez diferente. Código e comentário em **português**. Nome de variável
em português quando é do negócio (`gastoCents`, `bloqueadoAte`), em inglês
quando é da plataforma (`externalId`, `eventId`).

Comentário longo não é enfeite: quase todo comentário grande aqui é a lápide de
um defeito que custou caro. Ao mudar o código que ele descreve, **atualize-o** —
comentário que virou mentira é pior que comentário nenhum.

## Quem decide qual loja o painel mostra é o ENDEREÇO

`track.transforlar.com` é a loja dona do site `transforlar.com`. Ponto: sem
cookie, sem seletor, sem escolha.

**Por que isso precisou virar regra.** Todos os subdomínios apontam para o MESMO
app e o MESMO banco — a Vercel serve o projeto inteiro em qualquer domínio
ligado a ele. O subdomínio sozinho não isola nada. Antes disto, a loja vinha de
um cookie; cookie é por domínio, então abrir `track.transforlar.com` pela
primeira vez não tinha cookie nenhum e o código caía na PRIMEIRA loja da lista
— que é `ORDER BY tenants.name`. Com uma loja de QA na conta, o painel da
Transforlar abria mostrando a de QA. Endereço certo, dado de outra oferta na
tela, nada indicando a troca. **Aconteceu.**

O casamento usa `mesmoSite()`, a MESMA função que decide se o cookie de
primeira parte cola — duas noções de "mesmo site" divergiriam, e a divergência
apareceria como painel abrindo certo num domínio e errado noutro.

Consequências, todas de propósito:

- **o seletor de loja some** em `track.<oferta>`; fica só o nome, parado. No
  domínio do RRTrack ele continua, porque lá o painel é console — é de lá, ou
  do `npm run cadastrar`, que uma oferta nova nasce;
- **"adicionar loja" some junto**, pelo mesmo motivo;
- e abrir o `track.` de uma loja a que você não tem acesso **diz isso**, em vez
  de mostrar outra. A busca varre TODOS os sites ativos, não só os seus:
  filtrar pelos seus faria "loja que não é sua" parecer "endereço que não
  representa loja nenhuma", e aí cairia no cookie de novo.

`scripts/teste-isolamento.mjs` reprova se qualquer uma dessas voltar atrás.

## Escolher linha no escuro é sempre defeito

`limit(1)` sem `orderBy` numa busca que pode casar mais de uma linha **sorteia**
— e o Postgres não promete a mesma entre duas execuções. Esta classe mordeu
três vezes: o painel lia um site e a verificação do coletor gravava em outro; a
loja real ficava com a tela do site de teste; e o painel de `track.transforlar.com`
abria numa loja de QA. Sempre o mesmo defeito, um nível acima a cada vez.

A regra: **ou o filtro casa no máximo uma linha** (chave primária, ou coluna com
unicidade garantida pelo banco), **ou a consulta diz qual linha quer** com um
`orderBy`. Não há terceira opção que não seja sorteio. `teste-isolamento`
percorre todo `db.select(...).limit(1)` e reprova o que não se encaixar.

Um caso que passou despercebido por muito tempo e vale de exemplo: o índice
único de `meta_profiles` é `(tenantId, fbUserId)` — uma loja PODE ter dois
perfis do Facebook conectados, e é o caso de quem usa antidetect. As duas
consultas pegavam `limit(1)` sem ordem, então o painel mostrava o nome de um
enquanto o token usado era do outro. Hoje as duas ordenam por `connectedAt`
decrescente, e **a mesma ordem nos dois lugares** — divergir ali seria pior que
não mostrar nada.

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
