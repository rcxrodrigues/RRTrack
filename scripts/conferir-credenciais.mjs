/*
 * A CREDENTIALS_KEY deste .env decifra o que está guardado no banco?
 *
 * SÓ LÊ. Não escreve, não apaga, não decide nada. E não imprime credencial
 * nenhuma — só se ela abriu ou não, e quantos caracteres tinha. O objetivo é
 * responder a uma pergunta de configuração sem transformar o diagnóstico num
 * novo vazamento.
 *
 * POR QUE EXISTE. Uma chave incompatível não dá erro em lugar nenhum. Em
 * `core/receber.ts` a credencial ilegível cai num `catch` que segue adiante, e
 * a verificação de assinatura simplesmente deixa de acontecer: o webhook é
 * aceito com 200, marcado como não verificado. No disparo é parecido — o
 * adaptador não acha o token e o evento não sai. Os dois sintomas parecem
 * outra coisa (gateway mal configurado, pixel errado), e nenhum deles aponta
 * para a chave.
 *
 * Rodar: node scripts/conferir-credenciais.mjs
 */

import { neon } from "@neondatabase/serverless";

process.loadEnvFile(".env");

const sql = neon(process.env.DATABASE_URL);
const dec = new TextDecoder();

const bruta = process.env.CREDENTIALS_KEY;
if (!bruta) {
  console.error("\n  CREDENTIALS_KEY ausente no .env — nada a conferir.\n");
  process.exit(2);
}

let chave;
try {
  const bytes = Uint8Array.from(atob(bruta), (c) => c.charCodeAt(0));
  if (bytes.length !== 32) throw new Error(`tem ${bytes.length} bytes, precisa de 32`);
  chave = await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["decrypt"]);
} catch (e) {
  console.error(`\n  CREDENTIALS_KEY inválida: ${e.message}\n`);
  process.exit(2);
}

/** Mesmo formato de core/crypto.ts: "iv.textocifrado", ambos em base64. */
async function decifrar(guardado) {
  const [ivPart, dataPart] = guardado.split(".");
  if (!ivPart || !dataPart) throw new Error("formato inválido");
  const iv = Uint8Array.from(atob(ivPart), (c) => c.charCodeAt(0));
  const data = Uint8Array.from(atob(dataPart), (c) => c.charCodeAt(0));
  return dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, chave, data));
}

const TABELAS = [
  { nome: "gateway_connections", rotulo: "gateway", extra: "gateway" },
  { nome: "destinations", rotulo: "pixel", extra: "platform" },
  { nome: "ad_accounts", rotulo: "conta de anúncio", extra: "platform" },
];

let abriram = 0;
let falharam = 0;
let vazias = 0;

for (const t of TABELAS) {
  const linhas = await sql(
    `SELECT id, label, ${t.extra} AS especie, credentials FROM ${t.nome} ORDER BY label`,
  );
  if (!linhas.length) continue;

  console.log(`\n== ${t.nome} ==`);
  for (const l of linhas) {
    const campos = Object.entries(l.credentials ?? {});
    if (!campos.length) {
      vazias++;
      console.log(`  --   | ${l.especie}/${l.label}: sem credencial guardada`);
      continue;
    }

    const ok = [];
    const ruim = [];
    for (const [k, v] of campos) {
      try {
        const aberto = await decifrar(v);
        /* Só o tamanho. O valor não sai daqui. */
        ok.push(`${k}(${aberto.length})`);
      } catch {
        ruim.push(k);
      }
    }

    if (ruim.length) {
      falharam++;
      console.log(`  FALHA | ${l.especie}/${l.label}: NÃO decifrou ${ruim.join(", ")}`);
    } else {
      abriram++;
      console.log(`  ok    | ${l.especie}/${l.label}: ${ok.join(" ")}`);
    }
  }
}

console.log("\n" + "-".repeat(62));
console.log(`  abriram: ${abriram}   não abriram: ${falharam}   sem credencial: ${vazias}`);

if (falharam === 0 && abriram > 0) {
  console.log(`
  A chave deste .env é a mesma que cifrou o que está no banco.

  Então o 200 no lugar do 401 NÃO vem daqui — e a investigação continua
  na produção: é a CREDENTIALS_KEY da Vercel que precisa ser comparada
  com esta, porque quem decifra no webhook real é ela.
`);
} else if (abriram === 0 && falharam > 0) {
  console.log(`
  NENHUMA credencial abriu com esta chave.

  Quer dizer que este .env tem uma chave diferente da que cifrou os dados.
  Não troque nada ainda: a chave CERTA é a que está na Vercel, porque foi
  ela que cifrou o que está guardado. Trocar a da Vercel para esta tornaria
  ilegível tudo o que já existe.
`);
} else if (falharam > 0) {
  console.log(`
  ABRIU PARTE, e é o caso mais informativo dos três: houve troca de chave
  em algum momento, e as linhas gravadas antes dela ficaram órfãs. Elas
  precisam ser recadastradas pelo painel — não há como recuperá-las.
`);
} else {
  console.log(`
  Não há credencial guardada em lugar nenhum, então não dá para concluir
  nada sobre a chave. Cadastre um gateway ou pixel pelo painel e rode de novo.
`);
}

process.exit(falharam > 0 ? 1 : 0);
