/*
 * Converte o período escolhido na tela em datas, no fuso da loja.
 *
 * O fuso importa: "hoje" em UTC vira ontem às 21h em São Paulo, e o painel
 * mostraria o dia errado por três horas todo dia.
 */
/*
 * O período que abre quando ninguém escolheu.
 *
 * "Hoje" e não "7 dias": quem abre o painel no meio do dia quer saber como
 * está indo AGORA — se a campanha que subiu de manhã está pagando. Sete dias
 * dilui o dia corrente em seis anteriores e esconde exatamente o que se veio
 * olhar. Fica num lugar só para as quatro telas concordarem.
 */
export const PERIODO_PADRAO = "hoje";

export function janelaDe(periodo: string, timezone: string): { de: string; ate: string } {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: timezone });
  const dias = periodo === "hoje" ? 0
    : periodo === "14d" ? 13
    : periodo === "30d" ? 29 : 6;
  return {
    de: fmt.format(new Date(Date.now() - dias * 86400_000)),
    ate: fmt.format(new Date()),
  };
}

export function um(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? "";
}
