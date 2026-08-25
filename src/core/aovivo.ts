/*
 * Quem está no site agora, e de onde.
 *
 * A única tela do painel que não olha para trás. Todo o resto responde "como
 * foi"; esta responde "como está" — e por isso não aceita filtro de período:
 * agora é agora.
 *
 * O que faz o número significar alguma coisa é o pulso do rr.js. Sem ele,
 * "visitantes agora" seria "quem carregou uma página no último minuto", e
 * alguém lendo a página de vendas por dez minutos desapareceria da contagem
 * exatamente quando está mais atento.
 */

import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "../db/index";
import { clickSessions } from "../db/schema";

/*
 * Dois minutos de tolerância para um pulso de um minuto.
 *
 * Um minuto cravado marcaria como ausente quem teve um pulso atrasado por
 * aba em segundo plano ou rede ruim — e o número ficaria piscando. Três
 * minutos manteria na tela gente que já fechou o navegador há tempo.
 */
const JANELA_MS = 2 * 60_000;

export interface Local {
  pais: string | null;
  regiao: string | null;
  cidade: string | null;
  sessoes: number;
}

export interface AoVivo {
  /** Abas abertas com pulso recente. */
  agora: number;
  /** Visitantes distintos na última hora, para dar escala ao número de cima. */
  ultimaHora: number;
  /** De onde vieram as sessões da última hora, da maior para a menor. */
  locais: Local[];
  /** Quantas dessas sessões não têm origem conhecida. */
  semLocal: number;
}

export async function aoVivo(tenantId: string): Promise<AoVivo> {
  const agora = new Date(Date.now() - JANELA_MS);
  const hora = new Date(Date.now() - 60 * 60_000);

  const [contagem] = await db
    .select({
      agora: sql<number>`count(*) filter (where ${clickSessions.lastSeenAt} >= ${agora})::int`,
      hora: sql<number>`count(*)::int`,
    })
    .from(clickSessions)
    .where(and(
      eq(clickSessions.tenantId, tenantId),
      gte(clickSessions.lastSeenAt, hora),
    ));

  /*
   * O agrupamento é por país + região + cidade, como o Shopify mostra. Cidade
   * sozinha não basta: existe São Paulo em vários estados, e existem cidades
   * de mesmo nome em países diferentes.
   */
  const locais = await db
    .select({
      pais: clickSessions.country,
      regiao: clickSessions.region,
      cidade: clickSessions.city,
      sessoes: sql<number>`count(*)::int`,
    })
    .from(clickSessions)
    .where(and(
      eq(clickSessions.tenantId, tenantId),
      gte(clickSessions.lastSeenAt, hora),
    ))
    .groupBy(clickSessions.country, clickSessions.region, clickSessions.city)
    .orderBy(sql`count(*) desc`)
    .limit(12);

  /*
   * Sessão sem país é sessão que chegou antes de o coletor guardar origem, ou
   * de onde a Vercel não resolveu o IP. Fica fora da lista e vira um número
   * à parte — misturá-la com um "desconhecido" no topo do ranking daria a
   * impressão de que o maior mercado é lugar nenhum.
   */
  const comLocal = locais.filter((l) => l.pais);
  const semLocal = locais
    .filter((l) => !l.pais)
    .reduce((s, l) => s + l.sessoes, 0);

  return {
    agora: contagem?.agora ?? 0,
    ultimaHora: contagem?.hora ?? 0,
    locais: comLocal,
    semLocal,
  };
}

/* Siglas que a Vercel devolve, nos nomes que as pessoas usam. */
const PAISES: Record<string, string> = {
  BR: "Brasil", PT: "Portugal", US: "Estados Unidos", AR: "Argentina",
  CL: "Chile", CO: "Colômbia", MX: "México", ES: "Espanha", UY: "Uruguai",
  PY: "Paraguai", GB: "Reino Unido", CA: "Canadá", FR: "França", DE: "Alemanha",
  IT: "Itália", JP: "Japão", AU: "Austrália", AO: "Angola", MZ: "Moçambique",
};

const ESTADOS: Record<string, string> = {
  AC: "Acre", AL: "Alagoas", AP: "Amapá", AM: "Amazonas", BA: "Bahia",
  CE: "Ceará", DF: "Distrito Federal", ES: "Espírito Santo", GO: "Goiás",
  MA: "Maranhão", MT: "Mato Grosso", MS: "Mato Grosso do Sul",
  MG: "Minas Gerais", PA: "Pará", PB: "Paraíba", PR: "Paraná",
  PE: "Pernambuco", PI: "Piauí", RJ: "Rio de Janeiro",
  RN: "Rio Grande do Norte", RS: "Rio Grande do Sul", RO: "Rondônia",
  RR: "Roraima", SC: "Santa Catarina", SP: "São Paulo", SE: "Sergipe",
  TO: "Tocantins",
};

export function nomeDoPais(sigla: string | null): string {
  if (!sigla) return "Origem desconhecida";
  return PAISES[sigla] ?? sigla;
}

/*
 * Estado por extenso só no Brasil. Fora daqui a sigla que a Vercel devolve não
 * é a que o país usa — "ENG" para Inglaterra, números em alguns lugares — e
 * traduzir errado é pior que não traduzir.
 */
export function nomeDaRegiao(pais: string | null, sigla: string | null): string | null {
  if (!sigla) return null;
  if (pais === "BR") return ESTADOS[sigla] ?? sigla;
  return sigla;
}
