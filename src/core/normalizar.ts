/*
 * As duas armadilhas que TODO adaptador de gateway cai, e o conserto num
 * lugar só.
 *
 * Estão aqui porque cada adaptador tinha a sua cópia de `str()` e o seu
 * `new Date()`, e a correção de uma não chegava nas outras. Foi assim que a
 * pagou.ai ganhou o tratamento de nulo textual e o Appmax não.
 */

/*
 * ------------------------------------------------------- 1. nulo escrito
 *
 * `"null"`, a palavra, não é um valor.
 *
 * A pagou.ai manda `"phone": "null"` — quatro letras, não o nulo do JSON. Um
 * `typeof v === "string" && v.trim()` aceita isso de bom grado, e aí duas
 * coisas ruins acontecem: guarda-se um telefone de zero dígitos, e o
 * enriquecimento acredita que já tem telefone e NÃO busca o de verdade na API
 * do gateway. O dado existe dos dois lados e se perde no meio.
 *
 * Serializador que erra nulo é comum o bastante para não ser exceção de um
 * gateway: qualquer um pode fazer, e nenhum avisa.
 */
const NAO_E_VALOR = new Set([
  "null", "undefined", "nil", "none", "nan", "n/a", "na", "-", "--",
]);

/** Texto útil, ou `undefined`. Número vira texto; nulo escrito é ausência. */
export function texto(v: unknown): string | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : undefined;
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (!t || NAO_E_VALOR.has(t.toLowerCase())) return undefined;
  return t;
}

/*
 * ------------------------------------------------- 2. data sem fuso escrito
 *
 * "2026-08-22 14:30:00" não diz que horas são em lugar nenhum.
 *
 * O `new Date()` do JavaScript lê essa forma exata como hora LOCAL DO
 * SERVIDOR. Na Vercel o servidor é UTC, então a mesma string vira 14:30 UTC —
 * 11:30 em São Paulo. Se o gateway quis dizer 14:30 de Brasília, a venda entra
 * três horas adiantada, e perto da meia-noite isso a joga para o dia errado.
 *
 * O erro não aparece: a venda entra, com data plausível, no dia errado. O
 * faturamento do dia fecha diferente do extrato e ninguém sabe por quê. Este
 * projeto já perdeu três horas de faturamento por dia exatamente assim.
 *
 * A documentação da Appmax NÃO DIZ o fuso — foi conferido. Então a escolha é
 * uma suposição, e o certo é que ela seja explícita: cada adaptador declara o
 * que assume, e quem ler o código vê a aposta em vez de herdar um padrão
 * invisível.
 *
 * Data COM fuso escrito é sempre respeitada como veio; a suposição só entra
 * quando não há nada escrito.
 */

/*
 * O Brasil não tem horário de verão desde 2019, então -03:00 é fixo. Se voltar
 * um dia, isto precisa virar consulta de fuso de verdade — e o comentário
 * existe para que quem procurar encontre.
 */
const DESLOCAMENTO: Record<string, string> = {
  "America/Sao_Paulo": "-03:00",
  UTC: "Z",
};

const SEM_FUSO = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/;

/**
 * Converte texto em instante. `assumir` só vale quando a data não traz fuso.
 *
 *   instante("2026-08-22 14:30:00", "America/Sao_Paulo")  → 17:30 UTC
 *   instante("2026-08-22T14:30:00Z", "America/Sao_Paulo") → 14:30 UTC
 */
export function instante(v: unknown, assumir: string): Date | undefined {
  const t = texto(v);
  if (!t) return undefined;

  const cru = SEM_FUSO.test(t)
    ? t.replace(" ", "T") + (DESLOCAMENTO[assumir] ?? "Z")
    : t;

  const d = new Date(cru);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
