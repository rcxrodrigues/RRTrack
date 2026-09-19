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
npm test               # suíte inteira: 13 unitários + 6 de ponta a ponta + banco
npm run test:sem-banco # só o que dispensa .env — serve em clone novo
npm run build          # o build da Vercel, rodando aqui
npm run dev            # localhost:3000
```

`npm test` precisa de `DATABASE_URL` e `CREDENTIALS_KEY` no `.env`. Sem eles, 13
testes não rodam e a saída **diz isso em vez de mentir que passou** — foi feita
assim de propósito.

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

## Buracos conhecidos, de propósito

- **`sites.collectorHost` é escrito e nunca lido.** Enquanto isso, `rr.js` é
  script de terceiro, e no Safari com `?fbclid=` o cookie `_rr_cid` cai de 90
  dias para 24 horas. É perda de atribuição silenciosa. Ao resolver: **some** o
  subdomínio, não **substitua** o domínio — as URLs de webhook estão cadastradas
  nos painéis dos gateways e parariam de entregar sem erro nenhum.
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

## Estilo

Comentário explica **por quê**, não o quê — e principalmente o que aconteceu
quando se fez diferente. Código e comentário em **português**. Nome de variável
em português quando é do negócio (`gastoCents`, `bloqueadoAte`), em inglês
quando é da plataforma (`externalId`, `eventId`).

Comentário longo não é enfeite: quase todo comentário grande aqui é a lápide de
um defeito que custou caro. Ao mudar o código que ele descreve, **atualize-o** —
comentário que virou mentira é pior que comentário nenhum.
