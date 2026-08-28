import { redirect } from "next/navigation";
import { urlAutorizacao } from "@/ads/meta-oauth";
import { acharPeloSegredo, appDaMeta, urlDeRetorno } from "@/ads/meta-vinculo";

export const dynamic = "force-dynamic";

/*
 * A porta de entrada do link copiado.
 *
 * Fica FORA do painel de propósito: quem abre esta página está num navegador
 * antidetect, sem sessão do RRTrack e sem vontade de criar uma. O segredo da
 * URL é a credencial aqui, e ele só dá direito a uma coisa — mandar a pessoa
 * ao Facebook e trazer um token de volta para a fila. Nada é gravado na loja
 * por este caminho.
 */
export default async function PaginaLinkMeta({
  params,
}: {
  params: Promise<{ secret: string }>;
}) {
  const { secret } = await params;
  const vinculo = await acharPeloSegredo(secret);
  const app = appDaMeta();

  if (!vinculo || !app) {
    return (
      <div style={{
        maxWidth: 460, margin: "80px auto", padding: 28, textAlign: "center",
        fontFamily: "system-ui, sans-serif",
      }}>
        <h1 style={{ fontSize: 17, margin: "0 0 8px" }}>Este link não vale mais</h1>
        <p style={{ fontSize: 13, color: "#888", margin: 0, lineHeight: 1.5 }}>
          Links de vínculo duram quinze minutos, e cada um serve uma vez só.
          Gere outro no painel, em Integrações → Anúncios.
        </p>
      </div>
    );
  }

  redirect(urlAutorizacao(app, urlDeRetorno(), vinculo.secret));
}
