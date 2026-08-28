export const dynamic = "force-dynamic";

/*
 * O fim do caminho no navegador antidetect.
 *
 * Não há o que clicar aqui de propósito: a escolha do que vincular acontece no
 * painel, com sessão. Esta página existe para a pessoa saber que pode fechar a
 * aba — sem ela, o navegador pararia numa tela em branco e o vínculo pareceria
 * ter falhado justamente quando deu certo.
 */
export default async function PaginaPronto({
  searchParams,
}: {
  searchParams: Promise<{ erro?: string }>;
}) {
  const { erro } = await searchParams;

  return (
    <div style={{
      maxWidth: 460, margin: "80px auto", padding: 28, textAlign: "center",
      fontFamily: "system-ui, sans-serif",
    }}>
      <h1 style={{ fontSize: 17, margin: "0 0 8px" }}>
        {erro ? "Não deu para autorizar" : "Autorizado"}
      </h1>
      <p style={{ fontSize: 13, color: "#888", margin: 0, lineHeight: 1.5 }}>
        {erro
          ? erro
          : "Pode fechar esta aba. Volte ao painel do RRTrack, em Integrações → Anúncios, para escolher quais contas e pixels pertencem à loja."}
      </p>
    </div>
  );
}
