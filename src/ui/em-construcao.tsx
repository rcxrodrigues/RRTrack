/*
 * Marcador honesto para tela que ainda não existe.
 *
 * Melhor que um gráfico com número inventado: quem abre sabe na hora que não
 * há dado ali, em vez de tomar decisão em cima de exemplo.
 */
export function EmConstrucao({ titulo, descricao, precisa }: {
  titulo: string; descricao: string; precisa?: string;
}) {
  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontSize: 17, fontWeight: 700, margin: 0, letterSpacing: "-.2px" }}>{titulo}</h1>
      <p style={{ fontSize: 12.5, color: "var(--ink-fraco)", margin: "4px 0 20px", maxWidth: 560 }}>
        {descricao}
      </p>
      <div style={{
        maxWidth: 560, padding: "16px 18px", borderRadius: 8,
        background: "var(--painel)", border: "1px dashed var(--linha-forte)",
      }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-medio)", marginBottom: 5 }}>
          Ainda não construída
        </div>
        <div style={{ fontSize: 12, color: "var(--ink-tenue)", lineHeight: 1.55 }}>
          {precisa ?? "A coleta já está funcionando; falta a tela que mostra o que foi coletado."}
        </div>
      </div>
    </div>
  );
}
