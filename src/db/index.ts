/*
 * Conexão com o Postgres.
 *
 * Usa o driver HTTP da Neon em vez de uma conexão TCP comum. O motivo é o
 * ambiente: cada webhook e cada evento do coletor roda numa função serverless
 * separada, e um pool de conexões TCP tradicional esgotaria o limite do banco
 * em minutos num pico de tráfego. Sobre HTTP não há pool para esgotar.
 *
 * A conexão é preguiçosa de propósito. Se este módulo abrisse a conexão na
 * importação, o build quebraria em qualquer ambiente sem DATABASE_URL — e o
 * build não precisa de banco, só o tempo de execução precisa.
 */

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

type Db = ReturnType<typeof criar>;

function criar() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL ausente");
  return drizzle({ client: neon(url), schema });
}

let instancia: Db | null = null;

function obter(): Db {
  if (!instancia) instancia = criar();
  return instancia;
}

/*
 * Proxy para manter `db.select()` funcionando como se fosse a instância real,
 * sem obrigar cada chamador a lembrar de pedir a conexão antes.
 */
export const db = new Proxy({} as Db, {
  get(_alvo, prop, receptor) {
    return Reflect.get(obter() as object, prop, receptor);
  },
});

export { schema };
