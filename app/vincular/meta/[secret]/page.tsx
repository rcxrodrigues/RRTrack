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
 *
 * O BOTÃO NÃO É ENFEITE, e foi o que fez esta página existir.
 *
 * Antes daqui, a página respondia 307 direto para o facebook.com. Funcionava
 * em navegador comum e falhava exatamente onde precisava funcionar: no
 * antidetect, que é o motivo de o link existir. Esses navegadores passam a
 * navegação por uma camada de proxy e barram salto automático entre domínios
 * — ainda mais para o facebook.com. Clique de gente passa; redirecionamento
 * de servidor, não.
 *
 * Foi comparando com a Utmify que ficou claro: o link dela também é uma
 * página própria com um botão, e é por isso que abre onde o nosso não abria.
 */
export default async function PaginaLinkMeta({
  params,
}: {
  params: Promise<{ secret: string }>;
}) {
  const { secret } = await params;
  const vinculo = await acharPeloSegredo(secret);
  const app = appDaMeta();

  /*
   * Duas falhas diferentes, duas mensagens diferentes.
   *
   * Antes as duas diziam "este link não vale mais", e isso mandava a pessoa
   * gerar link atrás de link quando o problema era outro: faltar META_APP_ID
   * no servidor. Mensagem errada custa mais que mensagem feia — manda
   * consertar a coisa errada.
   */
  if (!app) {
    return (
      <Moldura>
        <h1 style={{ fontSize: 18, margin: "0 0 10px", fontWeight: 600 }}>
          Vínculo com a Meta não está configurado
        </h1>
        <p style={{ fontSize: 13.5, color: "#9aa4ad", margin: 0, lineHeight: 1.6 }}>
          Não é o seu link — é o servidor, que está sem as credenciais do
          aplicativo da Meta. Gerar outro link não resolve.
        </p>
      </Moldura>
    );
  }

  if (!vinculo) {
    return (
      <Moldura>
        <h1 style={{ fontSize: 18, margin: "0 0 10px", fontWeight: 600 }}>
          Este link não vale mais
        </h1>
        <p style={{ fontSize: 13.5, color: "#9aa4ad", margin: 0, lineHeight: 1.6 }}>
          Links de vínculo duram trinta minutos. Gere outro no painel, em
          Integrações → Anúncios.
        </p>
      </Moldura>
    );
  }

  const destino = urlAutorizacao(app, urlDeRetorno(), vinculo.secret);

  return (
    <Moldura>
      <h1 style={{ fontSize: 19, margin: "0 0 18px", fontWeight: 600 }}>
        Conectar Meta Ads
      </h1>

      <div style={{
        background: "#121C22", border: "1px solid #1B2830", borderRadius: 8,
        padding: "16px 18px", textAlign: "left", marginBottom: 22,
      }}>
        <div style={{
          fontSize: 13, fontWeight: 600, color: "#45C4D0", marginBottom: 9,
        }}>Autorização pelo Facebook</div>
        <p style={{ fontSize: 13, color: "#9aa4ad", margin: "0 0 10px", lineHeight: 1.6 }}>
          Ao continuar, o Facebook vai pedir sua permissão para o RRTrack ler
          suas contas de anúncio. A senha não passa por nós.
        </p>
        <p style={{ fontSize: 13, color: "#9aa4ad", margin: 0, lineHeight: 1.6 }}>
          Este link vale por <b style={{ color: "#c9d4db" }}>30 minutos</b> e
          serve a esta loja apenas.
        </p>
      </div>

      {/*
        Um <a> de verdade, e não um script que navega sozinho: o que faz isto
        atravessar o navegador antidetect é o clique ser da pessoa.
      */}
      <a
        href={destino}
        style={{
          display: "block", background: "#1877F2", color: "#fff",
          textDecoration: "none", borderRadius: 8, padding: "13px 20px",
          fontSize: 15, fontWeight: 600, textAlign: "center",
        }}
      >
        Continuar com Meta Ads
      </a>

      <p style={{
        fontSize: 11.5, color: "#566871", margin: "16px 0 0", lineHeight: 1.55,
      }}>
        Você pode fazer isto em qualquer navegador, inclusive num perfil
        separado. O vínculo fica guardado no servidor.
      </p>
    </Moldura>
  );
}

/*
 * Moldura própria, sem os estilos do painel.
 *
 * Quem abre isto está prestes a autorizar acesso à conta de anúncio dele. Uma
 * página crua, sem nome nem contexto, é exatamente o que um phishing pareceria
 * — então ela diz de quem é e o que vai acontecer antes de pedir o clique.
 */
function Moldura({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      minHeight: "100vh", background: "#0B1014", color: "#E4EDF1",
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: 20, fontFamily: "system-ui, -apple-system, sans-serif",
    }}>
      <div style={{
        width: "100%", maxWidth: 420, background: "#0F171C",
        border: "1px solid #1B2830", borderRadius: 12, padding: 28,
        textAlign: "center",
      }}>
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          gap: 8, marginBottom: 24,
        }}>
          <span style={{
            width: 9, height: 9, borderRadius: "50%", background: "#45C4D0",
          }} />
          <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-.2px" }}>
            RRTrack
          </span>
        </div>
        {children}
      </div>
    </div>
  );
}
