/*
 * Conexão com o Postgres.
 *
 * Usa o driver HTTP da Neon em vez de uma conexão TCP comum. O motivo é o
 * ambiente: cada webhook e cada evento do coletor roda numa função serverless
 * separada, e um pool de conexões TCP tradicional esgotaria o limite do banco
 * em minutos num pico de tráfego. Sobre HTTP não há pool para esgotar.
 */

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL ausente");

export const db = drizzle({ client: neon(url), schema });
export { schema };
