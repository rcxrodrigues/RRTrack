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

/*
 * Data de HOJE no fuso da loja, e não do servidor.
 *
 * `en-CA` porque o formato dele é AAAA-MM-DD, que é o que as consultas
 * esperam. Formatar em `pt-BR` daria 31/08/2026 e o filtro não casaria nada.
 */
function diaNaLoja(quando: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(quando);
}

/* Soma dias a uma data AAAA-MM-DD sem passar por fuso nenhum. */
function somarDias(dia: string, n: number): string {
  const d = new Date(dia + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/*
 * Converte o período escolhido em duas datas, no fuso da loja.
 *
 * `personalizado` recebe as datas prontas, vindas da URL. Quando vier
 * incompleto ou invertido, cai no padrão em vez de devolver janela vazia: o
 * painel mostrando zero por causa de um parâmetro torto é indistinguível de
 * um dia sem venda, e é o tipo de coisa que faz alguém achar que quebrou.
 */
export function janelaDe(
  periodo: string,
  timezone: string,
  custom?: { de?: string; ate?: string },
): { de: string; ate: string } {
  const hoje = diaNaLoja(new Date(), timezone);

  if (periodo === "personalizado") {
    const de = custom?.de;
    const ate = custom?.ate;
    const valida = (v: string | undefined) => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
    if (valida(de) && valida(ate)) {
      /* Invertidas: troca em vez de recusar. Quem escolheu quis o intervalo. */
      return de! <= ate! ? { de: de!, ate: ate! } : { de: ate!, ate: de! };
    }
    return { de: hoje, ate: hoje };
  }

  if (periodo === "ontem") {
    const ontem = somarDias(hoje, -1);
    return { de: ontem, ate: ontem };
  }

  if (periodo === "mes") return { de: hoje.slice(0, 8) + "01", ate: hoje };

  if (periodo === "mespassado") {
    const primeiroDesteMes = hoje.slice(0, 8) + "01";
    const ultimoDoPassado = somarDias(primeiroDesteMes, -1);
    return { de: ultimoDoPassado.slice(0, 8) + "01", ate: ultimoDoPassado };
  }

  /*
   * "Máximo" não busca a primeira venda da loja: usa uma borda anterior ao
   * projeto existir. Uma consulta a mais para descobrir o começo custaria
   * mais que varrer alguns anos de índice, e o resultado seria o mesmo.
   */
  if (periodo === "max") return { de: "2020-01-01", ate: hoje };

  const dias = periodo === "hoje" ? 0
    : periodo === "14d" ? 13
    : periodo === "30d" ? 29 : 6;
  return { de: somarDias(hoje, -dias), ate: hoje };
}

export function um(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? "";
}
