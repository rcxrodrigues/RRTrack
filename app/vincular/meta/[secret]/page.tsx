import { urlAutorizacao } from "@/ads/meta-oauth";
import { acharPeloSegredo, appDaMeta, urlDeRetorno } from "@/ads/meta-vinculo";
import { LogoMeta } from "@/ui/logos";

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
 * antidetect, que é o motivo de o link existir. Clique de gente atravessa a
 * camada de proxy desses navegadores; redirecionamento de servidor, não.
 *
 * O RESTO DA PÁGINA TAMBÉM NÃO É ENFEITE. Quem abre isto está prestes a
 * entregar acesso à conta de anúncio dele — página crua, sem marca e sem
 * explicação, é exatamente o que um phishing pareceria. Marca no topo, o
 * logo da plataforma que vai pedir a permissão, e o que acontece ao clicar,
 * dito antes do clique.
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
        <Aviso
          titulo="Vínculo com a Meta não está configurado"
          texto="Não é o seu link — é o servidor, que está sem as credenciais do aplicativo da Meta. Gerar outro link não resolve."
        />
      </Moldura>
    );
  }

  if (!vinculo) {
    return (
      <Moldura>
        <Aviso
          titulo="Este link não vale mais"
          texto="Links de vínculo duram trinta minutos. Gere outro no painel, em Integrações → Anúncios."
        />
      </Moldura>
    );
  }

  return (
    <Moldura>
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 22 }}>
        <LogoMeta tamanho={62} />
      </div>

      <h1 style={{
        fontSize: 23, fontWeight: 700, margin: "0 0 26px",
        textAlign: "center", letterSpacing: "-.3px",
      }}>
        Conectar Meta Ads
      </h1>

      <div style={{
        background: "#121C22", border: "1px solid #1B2830", borderRadius: 10,
        padding: "18px 20px", textAlign: "left", marginBottom: 26,
      }}>
        <div style={{
          fontSize: 14.5, fontWeight: 600, color: "#45C4D0", marginBottom: 12,
        }}>
          Autorização pelo Facebook
        </div>
        <p style={{ fontSize: 13.5, color: "#9aa4ad", margin: "0 0 12px", lineHeight: 1.65 }}>
          Ao clicar em &quot;Continuar com Meta Ads&quot;, o Facebook vai pedir
          sua permissão para o RRTrack ler suas contas de anúncio.
        </p>
        <p style={{ fontSize: 13.5, color: "#9aa4ad", margin: "0 0 12px", lineHeight: 1.65 }}>
          A autorização acontece no site do Facebook. Sua senha não passa por
          nós em momento nenhum.
        </p>
        <p style={{ fontSize: 13.5, color: "#c9d4db", margin: 0, lineHeight: 1.65, fontWeight: 500 }}>
          Este link fica disponível por 30 minutos.
        </p>
      </div>

      <p style={{
        fontSize: 13.5, color: "#9aa4ad", textAlign: "center",
        margin: "0 0 8px", lineHeight: 1.6,
      }}>
        Você está prestes a conectar sua conta Meta Ads.
      </p>
      <p style={{
        fontSize: 13.5, color: "#9aa4ad", textAlign: "center",
        margin: "0 0 22px", lineHeight: 1.6,
      }}>
        Clique no botão abaixo para continuar.
      </p>

      {/*
        Um <a> de verdade, e não um script que navega sozinho: o que faz isto
        atravessar o navegador antidetect é o clique ser da pessoa.
      */}
      <a
        href={urlAutorizacao(app, urlDeRetorno(), vinculo.secret)}
        style={{
          display: "block", background: "#1877F2", color: "#fff",
          textDecoration: "none", borderRadius: 8, padding: "14px 24px",
          fontSize: 15, fontWeight: 600, textAlign: "center",
          maxWidth: 280, margin: "0 auto",
        }}
      >
        Continuar com Meta Ads
      </a>

      <p style={{
        fontSize: 12, color: "#566871", textAlign: "center",
        margin: "22px 0 0", lineHeight: 1.6,
      }}>
        Pode ser feito em qualquer navegador, inclusive num perfil separado.
        O vínculo fica guardado no servidor.
      </p>
    </Moldura>
  );
}

function Aviso({ titulo, texto }: { titulo: string; texto: string }) {
  return (
    <div style={{ textAlign: "center", padding: "10px 0 6px" }}>
      <h1 style={{ fontSize: 19, margin: "0 0 12px", fontWeight: 600 }}>{titulo}</h1>
      <p style={{ fontSize: 13.5, color: "#9aa4ad", margin: 0, lineHeight: 1.65 }}>
        {texto}
      </p>
    </div>
  );
}

/*
 * Moldura própria, sem os estilos do painel.
 *
 * As cores são escritas na mão em vez de virem das variáveis do tema porque
 * esta página não carrega o CSS do painel — ela precisa se sustentar sozinha,
 * inclusive se alguém abrir com o cache limpo num navegador que nunca viu o
 * sistema.
 */
function Moldura({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      minHeight: "100vh", background: "#0B1014", color: "#E4EDF1",
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: 20, fontFamily: "system-ui, -apple-system, sans-serif",
    }}>
      <div style={{
        width: "100%", maxWidth: 520, background: "#0F171C",
        border: "1px solid #1B2830", borderRadius: 14, overflow: "hidden",
      }}>
        {/*
          A faixa do topo com a marca. Separada por uma linha porque é o que
          diz "isto é um site, e é este aqui" antes de qualquer outra coisa —
          a diferença entre uma página de autorização e uma tela de golpe.
        */}
        <div style={{
          padding: "20px 28px", borderBottom: "1px solid #1B2830",
          display: "flex", justifyContent: "center",
        }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/marca/completa.png" alt="RRTrack" height={26}
            style={{ display: "block", width: "auto" }} />
        </div>

        <div style={{ padding: "30px 28px 28px" }}>
          {children}
        </div>
      </div>
    </div>
  );
}
