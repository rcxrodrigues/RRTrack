/*
 * Autenticação do Google Ads.
 *
 * Diferente da Meta e do TikTok, que aceitam um token longo e pronto, o Google
 * exige OAuth2: guarda-se um refresh token e troca-se por um access token de
 * uma hora a cada uso. É mais peça para quebrar, mas não há alternativa — não
 * existe equivalente ao usuário de sistema aqui.
 *
 * Três credenciais, e cada uma vem de um lugar diferente:
 *
 *   developerToken   do Google Ads API Center, e precisa de APROVAÇÃO deles
 *   clientId/Secret  do Google Cloud Console, projeto OAuth
 *   refreshToken     do consentimento único que o dono da conta dá
 *
 * A aprovação do developer token é o passo que trava: sai em dias, não em
 * minutos, e sem ele nenhuma chamada funciona.
 *
 * E há uma fragilidade que a Meta não tem: o refresh token PERTENCE À CONTA
 * que deu o consentimento. Se aquele perfil perder acesso, trocar senha ou
 * revogar a autorização, o token morre e a sincronização para em silêncio.
 * O usuário de sistema da Meta sobrevive a tudo isso; aqui não há equivalente.
 *
 * Consequência prática, e vale para quem for autorizar: use uma conta que vá
 * continuar existindo — de preferência uma que acesse a conta de anúncio pela
 * gerenciadora, e não um perfil pessoal que amanhã pode ficar inacessível.
 */

import type { CredenciaisAnuncio } from "./types";

/*
 * Cache do access token em memória do processo.
 *
 * Vale por uma hora e a troca custa uma chamada de rede. Sem cache, uma
 * sincronização que pagina dez vezes trocaria o token dez vezes — e cada troca
 * conta contra a cota do OAuth, não só a lentidão.
 *
 * Em ambiente serverless o processo é efêmero, então o cache ajuda dentro de
 * uma execução e some depois. É exatamente onde ele precisa ajudar.
 */
const cache = new Map<string, { token: string; expiraEm: number }>();

export async function accessToken(cred: CredenciaisAnuncio): Promise<string> {
  const { clientId, clientSecret, refreshToken } = cred;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "conta do Google sem OAuth completo — precisa de client id, client secret e refresh token",
    );
  }

  const chave = `${clientId}:${refreshToken.slice(-12)}`;
  const guardado = cache.get(chave);
  /* Renova um minuto antes de vencer, para não usar um token que expira no meio. */
  if (guardado && guardado.expiraEm > Date.now() + 60_000) return guardado.token;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    const corpo = await res.text().catch(() => "");
    /*
     * `invalid_grant` quase sempre quer dizer que o consentimento foi revogado
     * ou a senha da conta Google mudou. Vale nomear: é o único erro daqui que
     * o lojista resolve sozinho, reautorizando.
     */
    if (corpo.includes("invalid_grant")) {
      throw new Error("autorização do Google expirou ou foi revogada — refaça o consentimento");
    }
    throw new Error(`Google recusou o refresh token: ${res.status}`);
  }

  const j = await res.json() as { access_token?: string; expires_in?: number };
  if (!j.access_token) throw new Error("Google não devolveu access token");

  cache.set(chave, {
    token: j.access_token,
    expiraEm: Date.now() + (j.expires_in ?? 3600) * 1000,
  });

  return j.access_token;
}

/*
 * Versão da API na URL. O Google aposenta versão a cada poucos meses.
 *
 * O valor mora em `core/versoes.ts`, junto com o da Meta; aqui fica só o
 * reexport, para que quem já importava `VERSAO` daqui continue funcionando.
 */
export { GOOGLE_ADS as VERSAO } from "../core/versoes";

/**
 * Cabeçalhos comuns.
 *
 * `login-customer-id` só vai quando a conta é acessada por uma gerenciadora
 * (MCC). Mandar quando não há gerenciadora faz o Google recusar, então ele é
 * condicional e não fixo.
 */
export function cabecalhos(token: string, cred: CredenciaisAnuncio): Record<string, string> {
  const h: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  if (cred.developerToken) h["developer-token"] = cred.developerToken;
  if (cred.loginCustomerId) h["login-customer-id"] = cred.loginCustomerId.replace(/\D/g, "");
  return h;
}

/** O Google quer o id da conta só com dígitos, sem os hífens que ele mesmo mostra. */
export function soDigitos(id: string): string {
  return id.replace(/\D/g, "");
}
