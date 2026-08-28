"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CheckoutPublico } from "@/checkout/index";

/*
 * A página onde o comprador paga.
 *
 * Duas decisões dominam este arquivo.
 *
 * 1. O NÚMERO DO CARTÃO NÃO PASSA PELO NOSSO SERVIDOR. Ele vai daqui direto
 *    para a Appmax, que devolve um token, e é o token que o nosso servidor
 *    recebe. Isso mantém o checkout no questionário PCI mais simples (SAQ-A)
 *    em vez do regime completo, com varredura trimestral e auditoria.
 *
 *    A Appmax publica um `appmax.min.js` que faria isso, mas ele funciona
 *    prendendo um `submit` a um `<form data-appmax-checkout>` — o que obriga
 *    o formulário a existir no DOM antes de o script rodar, e cria uma corrida
 *    com o React em que apertar "pagar" cedo demais recarrega a página. Ler o
 *    script mostrou que ele só faz um POST sem autenticação para o endereço
 *    abaixo, e que o "fingerprint" que ele calcula é descartado sem ir a lugar
 *    nenhum. Então fazemos o POST nós mesmos: mesmo destino, mesmo corpo, sem
 *    a corrida. Para reconferir o endereço um dia, basta abrir
 *    https://scripts.appmax.com.br/appmax.min.js e procurar `tokenizeCard`.
 *
 * 2. O PREÇO NÃO MORA AQUI. Os valores exibidos vêm do servidor e servem para
 *    a pessoa ler; o que o servidor cobra ele decide sozinho, relendo a oferta
 *    no banco. Mexer no DOM desta página não muda o valor de nada.
 */

/* Ritmo da espera do Pix, e até quando esperar. */
const INTERVALO_PIX_MS = 4000;
const ESPERA_MAX_MS = 30 * 60_000;

const TOKENIZE_URL =
  "https://hdixjlm06b.execute-api.sa-east-1.amazonaws.com/production/v1/payments/tokenize";

/* ------------------------------------------------------------- máscaras -- */

const so = (v: string) => v.replace(/\D/g, "");

const brl = (c: number) =>
  "R$ " + (c / 100).toFixed(2).replace(".", ",").replace(/\B(?=(\d{3})+(?!\d))/g, ".");

const mascaraCpf = (v: string) => {
  const d = so(v).slice(0, 11);
  return d
    .replace(/^(\d{3})(\d)/, "$1.$2")
    .replace(/^(\d{3})\.(\d{3})(\d)/, "$1.$2.$3")
    .replace(/\.(\d{3})(\d{1,2})$/, ".$1-$2");
};

const mascaraTelefone = (v: string) => {
  const d = so(v).slice(0, 11);
  if (d.length <= 10) return d.replace(/^(\d{2})(\d)/, "($1) $2").replace(/(\d{4})(\d)/, "$1-$2");
  return d.replace(/^(\d{2})(\d)/, "($1) $2").replace(/(\d{5})(\d)/, "$1-$2");
};

const mascaraCep = (v: string) => so(v).slice(0, 8).replace(/^(\d{5})(\d)/, "$1-$2");

const mascaraCartao = (v: string) =>
  so(v).slice(0, 19).replace(/(\d{4})(?=\d)/g, "$1 ").trim();

const mascaraValidade = (v: string) => {
  const d = so(v).slice(0, 6);
  return d.length <= 2 ? d : d.slice(0, 2) + "/" + d.slice(2);
};

/* ---------------------------------------------------------- tokenização -- */

interface CartaoBruto {
  numero: string;
  titular: string;
  mes: string;
  ano: string;
  cvv: string;
}

async function pedirToken(c: CartaoBruto, externalId: string, ano: string): Promise<string> {
  const res = await fetch(TOKENIZE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "external-id": externalId },
    body: JSON.stringify({
      payment_data: {
        credit_card: {
          number: so(c.numero),
          holder_name: c.titular,
          expiration_month: c.mes,
          expiration_year: ano,
          cvv: c.cvv,
        },
      },
    }),
  });

  if (!res.ok) throw new Error(`tokenize ${res.status}`);
  const j = await res.json() as { data?: { token?: string } };
  if (!j.data?.token) throw new Error("sem token");
  return j.data.token;
}

/*
 * A Appmax não documenta se `expiration_year` é "29" ou "2029" — o script dela
 * repassa o que estiver no campo, sem normalizar. Tentamos com quatro dígitos e,
 * se ela recusar, com dois. O custo é uma requisição a mais só quando já deu
 * errado; a alternativa é adivinhar e ter metade dos cartões falhando.
 */
async function tokenizar(c: CartaoBruto, externalId: string): Promise<string> {
  const quatro = c.ano.length === 2 ? "20" + c.ano : c.ano;
  const dois = quatro.slice(-2);
  try {
    return await pedirToken(c, externalId, quatro);
  } catch {
    return await pedirToken(c, externalId, dois);
  }
}

/* ------------------------------------------------------------- página -- */

type Fase = "formulario" | "processando" | "pix" | "aprovado";

interface RespostaPagar {
  ok: boolean;
  tipo?: string;
  motivo?: string;
  gatewayOrderId?: string;
  metodo?: string;
  pix?: { qrcodeBase64?: string; emv?: string; expiraEm?: string };
  redirect?: string;
}

export function Checkout({ checkout, clickIdUrl, totais: totaisServidor }: {
  checkout: CheckoutPublico;
  /* O clickId que veio no link do site do lojista. Ver app/c/[slug]/page.tsx. */
  clickIdUrl?: string;
  totais?: { produtosCents: number; freteCents: number; totalCents: number };
}) {
  const cor = checkout.config.cor || "#111827";

  /*
   * O servidor manda os totais prontos, calculados pela mesma função que a
   * cobrança usa. Recalcular aqui seria criar uma segunda aritmética que um dia
   * discorda da primeira, e a divergência apareceria como preço na tela
   * diferente do valor cobrado.
   */
  const totais = useMemo(() => ({
    produtos: totaisServidor?.produtosCents
      ?? checkout.items.reduce((s, i) => s + i.unitPriceCents * i.quantity, 0),
    frete: totaisServidor?.freteCents ?? checkout.shippingCents,
    total: totaisServidor?.totalCents
      ?? checkout.items.reduce((s, i) => s + i.unitPriceCents * i.quantity, 0)
        + checkout.shippingCents,
  }), [checkout, totaisServidor]);

  const metodos = checkout.methods.filter((m) => m === "pix" || m === "credit_card");
  const [metodo, setMetodo] = useState<string>(metodos[0] ?? "pix");

  const [fase, setFase] = useState<Fase>("formulario");
  const [erro, setErro] = useState<string | null>(null);
  const [pix, setPix] = useState<RespostaPagar["pix"]>();
  const [pedido, setPedido] = useState<string>();
  const [copiado, setCopiado] = useState(false);

  /* Dados do comprador */
  const [nome, setNome] = useState("");
  const [email, setEmail] = useState("");
  const [telefone, setTelefone] = useState("");
  const [documento, setDocumento] = useState("");

  /* Endereço */
  const [cep, setCep] = useState("");
  const [rua, setRua] = useState("");
  const [numero, setNumero] = useState("");
  const [complemento, setComplemento] = useState("");
  const [bairro, setBairro] = useState("");
  const [cidade, setCidade] = useState("");
  const [estado, setEstado] = useState("");

  /* Cartão — este estado nunca sai do navegador. */
  const [numCartao, setNumCartao] = useState("");
  const [titular, setTitular] = useState("");
  const [validade, setValidade] = useState("");
  const [cvv, setCvv] = useState("");
  const [parcelas, setParcelas] = useState(1);

  /* Só pede endereço quando há algo físico para entregar. */
  const precisaEndereco = checkout.items.some((i) => !i.digital);

  /* ------------------------------------------------------ rastreamento -- */
  useEffect(() => {
    const w = window as unknown as { rr?: (cmd: string, ...a: unknown[]) => unknown };
    try {
      w.rr?.("track", "begin_checkout", {
        value: totais.total / 100,
        items: checkout.items.map((i) => ({
          item_id: i.sku, item_name: i.name, quantity: i.quantity,
          price: i.unitPriceCents / 100,
        })),
      });
    } catch { /* sem rr.js a página funciona igual, só perde a origem */ }
  }, [checkout.items, totais.total]);

  /* -------------------------------------------------------------- CEP -- */
  async function buscarCep(valor: string) {
    const d = so(valor);
    if (d.length !== 8) return;
    try {
      const r = await fetch(`https://viacep.com.br/ws/${d}/json/`);
      const j = await r.json() as Record<string, string>;
      if (j.erro) return;
      /* Não sobrescreve o que a pessoa já corrigiu na mão. */
      setRua((v) => v || j.logradouro || "");
      setBairro((v) => v || j.bairro || "");
      setCidade((v) => v || j.localidade || "");
      setEstado((v) => v || j.uf || "");
    } catch { /* offline ou fora do ar: a pessoa preenche na mão */ }
  }

  /* ------------------------------------------------- espera do pix ----- */
  const pararRef = useRef(false);

  useEffect(() => {
    if (fase !== "pix" || !pedido) return;
    pararRef.current = false;
    const comecou = Date.now();

    const t = setInterval(async () => {
      if (pararRef.current) return;

      /*
       * Quem gerou o Pix e não pagou deixa a aba aberta — às vezes o dia
       * inteiro. Sem um fim, cada desistência viraria uma consulta a cada
       * quatro segundos para sempre, e a conta é nossa. Meia hora cobre com
       * folga quem saiu para abrir o app do banco.
       */
      if (Date.now() - comecou > ESPERA_MAX_MS) {
        pararRef.current = true;
        clearInterval(t);
        return;
      }

      /* Aba escondida não consulta: ninguém está olhando a resposta. */
      if (document.visibilityState !== "visible") return;

      try {
        const r = await fetch(
          `/api/checkout/estado?checkout=${encodeURIComponent(checkout.slug)}&pedido=${encodeURIComponent(pedido)}`,
          { cache: "no-store" },
        );
        const j = await r.json() as { estado?: string };
        if (j.estado === "pago") {
          pararRef.current = true;
          setFase("aprovado");
        }
      } catch { /* rede instável: tenta no próximo ciclo */ }
    }, INTERVALO_PIX_MS);

    /* Voltar para a aba pergunta na hora, sem esperar o ciclo — é exatamente
       o momento em que a pessoa acabou de pagar no banco. */
    const aoVoltar = () => {
      if (document.visibilityState !== "visible" || pararRef.current) return;
      fetch(
        `/api/checkout/estado?checkout=${encodeURIComponent(checkout.slug)}&pedido=${encodeURIComponent(pedido)}`,
        { cache: "no-store" },
      )
        .then((r) => r.json())
        .then((j: { estado?: string }) => {
          if (j.estado === "pago") { pararRef.current = true; setFase("aprovado"); }
        })
        .catch(() => { /* o ciclo tenta de novo */ });
    };
    document.addEventListener("visibilitychange", aoVoltar);

    return () => {
      pararRef.current = true;
      clearInterval(t);
      document.removeEventListener("visibilitychange", aoVoltar);
    };
  }, [fase, pedido, checkout.slug]);

  /* Depois de aprovado, leva para a página de obrigado, se houver. */
  useEffect(() => {
    if (fase !== "aprovado") return;
    const destino = checkout.config.redirectUrl;
    if (!destino) return;
    const t = setTimeout(() => { window.location.href = destino; }, 2500);
    return () => clearTimeout(t);
  }, [fase, checkout.config.redirectUrl]);

  /* ------------------------------------------------------------ enviar -- */
  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    setErro(null);
    setFase("processando");

    try {
      let cartao: { token: string; titular: string; documento: string } | undefined;

      if (metodo === "credit_card") {
        const [mes, ano] = validade.split("/");
        if (!mes || !ano || mes.length !== 2) {
          setErro("Validade inválida. Use MM/AA.");
          setFase("formulario");
          return;
        }

        let token: string;
        try {
          token = await tokenizar(
            { numero: numCartao, titular, mes, ano, cvv },
            checkout.config.appmaxExternalId ?? "",
          );
        } catch {
          setErro("Não foi possível validar o cartão. Confira os dados e tente de novo.");
          setFase("formulario");
          return;
        }

        cartao = { token, titular, documento };
      }

      /*
       * O da URL vem primeiro: é o clique que trouxe a pessoa do site do
       * lojista. O do rr.js é reserva para quem caiu direto aqui.
       */
      const w = window as unknown as { rr?: (cmd: string) => string | undefined };
      let clickId = clickIdUrl;
      if (!clickId) {
        try { clickId = w.rr?.("clickId"); } catch { /* sem rr.js */ }
      }

      const r = await fetch("/api/checkout/pagar", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: checkout.slug,
          clickId,
          metodo,
          parcelas,
          cartao,
          comprador: {
            nome, email, telefone, documento,
            ...(precisaEndereco
              ? { cep, rua, numero, complemento, bairro, cidade, estado }
              : {}),
          },
        }),
      });

      const j = await r.json() as RespostaPagar;

      if (!j.ok) {
        setErro(j.motivo ?? "Não foi possível concluir o pagamento.");
        setFase("formulario");
        return;
      }

      setPedido(j.gatewayOrderId);

      if (j.metodo === "pix") {
        setPix(j.pix);
        setFase("pix");
      } else {
        setFase("aprovado");
      }
    } catch {
      setErro("Falha de conexão. Tente novamente.");
      setFase("formulario");
    }
  }

  const ocupado = fase === "processando";

  /* ------------------------------------------------------------ telas -- */

  if (fase === "aprovado") {
    return (
      <Moldura checkout={checkout} cor={cor}>
        <div className="ck-final">
          <div className="ck-selo" style={{ background: cor }}>✓</div>
          <h2>Pagamento confirmado</h2>
          <p>
            Obrigado, {nome.split(" ")[0]}. Enviamos a confirmação para <b>{email}</b>.
          </p>
          {pedido && <p className="ck-nota">Pedido nº {pedido}</p>}
        </div>
      </Moldura>
    );
  }

  if (fase === "pix" && pix) {
    return (
      <Moldura checkout={checkout} cor={cor}>
        <div className="ck-final">
          <h2>Falta pagar o Pix</h2>
          <p>Abra o app do seu banco, escaneie o código e o pedido é confirmado na hora.</p>

          {pix.qrcodeBase64 && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              className="ck-qr"
              src={`data:image/png;base64,${pix.qrcodeBase64}`}
              alt="QR Code do Pix"
            />
          )}

          {pix.emv && (
            <>
              <div className="ck-emv">{pix.emv}</div>
              <button
                type="button"
                className="ck-botao"
                style={{ background: cor }}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(pix.emv ?? "");
                    setCopiado(true);
                    setTimeout(() => setCopiado(false), 2500);
                  } catch { /* navegador sem permissão: o código está à vista */ }
                }}
              >
                {copiado ? "Código copiado" : "Copiar código Pix"}
              </button>
            </>
          )}

          <p className="ck-nota ck-espera">
            <span className="ck-ponto" /> Aguardando o pagamento. Esta tela muda sozinha.
          </p>
          {pix.expiraEm && <p className="ck-nota">O código expira em {pix.expiraEm}.</p>}
        </div>
      </Moldura>
    );
  }

  return (
    <Moldura checkout={checkout} cor={cor} resumo={<Resumo checkout={checkout} totais={totais} />}>
      <form onSubmit={enviar} className="ck-form">
        <fieldset disabled={ocupado}>
          <h3 className="ck-titulo">Seus dados</h3>

          <Campo rotulo="Nome completo">
            <input value={nome} onChange={(e) => setNome(e.target.value)}
              autoComplete="name" required placeholder="Como está no documento" />
          </Campo>

          <div className="ck-linha">
            <Campo rotulo="E-mail">
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                autoComplete="email" required placeholder="voce@email.com" />
            </Campo>
            <Campo rotulo="Celular">
              <input value={telefone} onChange={(e) => setTelefone(mascaraTelefone(e.target.value))}
                autoComplete="tel" required inputMode="numeric" placeholder="(11) 99999-9999" />
            </Campo>
          </div>

          <Campo rotulo="CPF">
            <input value={documento} onChange={(e) => setDocumento(mascaraCpf(e.target.value))}
              required inputMode="numeric" placeholder="000.000.000-00" />
          </Campo>

          {precisaEndereco && (
            <>
              <h3 className="ck-titulo">Entrega</h3>

              <div className="ck-linha">
                <Campo rotulo="CEP">
                  <input value={cep} required inputMode="numeric" placeholder="00000-000"
                    onChange={(e) => {
                      const v = mascaraCep(e.target.value);
                      setCep(v);
                      void buscarCep(v);
                    }} />
                </Campo>
                <Campo rotulo="Número">
                  <input value={numero} onChange={(e) => setNumero(e.target.value)}
                    required placeholder="123" />
                </Campo>
              </div>

              <Campo rotulo="Endereço">
                <input value={rua} onChange={(e) => setRua(e.target.value)}
                  autoComplete="street-address" required placeholder="Rua, avenida..." />
              </Campo>

              <div className="ck-linha">
                <Campo rotulo="Bairro">
                  <input value={bairro} onChange={(e) => setBairro(e.target.value)} required />
                </Campo>
                <Campo rotulo="Complemento" opcional>
                  <input value={complemento} onChange={(e) => setComplemento(e.target.value)}
                    placeholder="Apto, bloco" />
                </Campo>
              </div>

              <div className="ck-linha">
                <Campo rotulo="Cidade">
                  <input value={cidade} onChange={(e) => setCidade(e.target.value)} required />
                </Campo>
                <Campo rotulo="UF">
                  <input value={estado} maxLength={2} required
                    onChange={(e) => setEstado(e.target.value.toUpperCase())} />
                </Campo>
              </div>
            </>
          )}

          <h3 className="ck-titulo">Pagamento</h3>

          {metodos.length > 1 && (
            <div className="ck-metodos">
              {metodos.map((m) => (
                <button key={m} type="button"
                  className={"ck-metodo" + (metodo === m ? " ck-ativo" : "")}
                  style={metodo === m ? { borderColor: cor, color: cor } : undefined}
                  onClick={() => setMetodo(m)}>
                  {m === "pix" ? "Pix" : "Cartão de crédito"}
                </button>
              ))}
            </div>
          )}

          {metodo === "pix" ? (
            <p className="ck-aviso">
              Ao continuar, mostramos o código Pix. A confirmação é imediata.
            </p>
          ) : (
            <>
              <Campo rotulo="Número do cartão">
                <input value={numCartao} required inputMode="numeric" placeholder="0000 0000 0000 0000"
                  autoComplete="cc-number"
                  onChange={(e) => setNumCartao(mascaraCartao(e.target.value))} />
              </Campo>

              <Campo rotulo="Nome impresso no cartão">
                <input value={titular} onChange={(e) => setTitular(e.target.value.toUpperCase())}
                  autoComplete="cc-name" required placeholder="COMO ESTÁ NO CARTÃO" />
              </Campo>

              <div className="ck-linha">
                <Campo rotulo="Validade">
                  <input value={validade} required inputMode="numeric" placeholder="MM/AA"
                    autoComplete="cc-exp"
                    onChange={(e) => setValidade(mascaraValidade(e.target.value))} />
                </Campo>
                <Campo rotulo="CVV">
                  <input value={cvv} required inputMode="numeric" placeholder="000"
                    autoComplete="cc-csc" maxLength={4}
                    onChange={(e) => setCvv(so(e.target.value))} />
                </Campo>
              </div>

              {checkout.maxInstallments > 1 && (
                <Campo rotulo="Parcelamento">
                  <select value={parcelas} onChange={(e) => setParcelas(Number(e.target.value))}>
                    {Array.from({ length: checkout.maxInstallments }, (_, i) => i + 1).map((n) => (
                      <option key={n} value={n}>
                        {n}x de {brl(Math.round(totais.total / n))}
                        {n > 1 ? " sem juros" : ""}
                      </option>
                    ))}
                  </select>
                </Campo>
              )}
            </>
          )}

          {erro && <div className="ck-erro">{erro}</div>}

          <button type="submit" className="ck-botao ck-pagar" style={{ background: cor }}>
            {ocupado
              ? "Processando..."
              : metodo === "pix" ? `Gerar Pix de ${brl(totais.total)}` : `Pagar ${brl(totais.total)}`}
          </button>

          <p className="ck-seguro">
            Pagamento processado pela Appmax. Seus dados de cartão não passam por este site.
          </p>
        </fieldset>
      </form>
    </Moldura>
  );
}

/* ---------------------------------------------------------- fragmentos -- */

function Campo({ rotulo, opcional, children }: {
  rotulo: string; opcional?: boolean; children: React.ReactNode;
}) {
  return (
    <label className="ck-campo">
      <span>{rotulo}{opcional && <i> (opcional)</i>}</span>
      {children}
    </label>
  );
}

function Resumo({ checkout, totais }: {
  checkout: CheckoutPublico;
  totais: { produtos: number; frete: number; total: number };
}) {
  return (
    <div className="ck-resumo">
      <h3 className="ck-titulo">Seu pedido</h3>
      {checkout.items.map((i, n) => (
        <div key={n} className="ck-item">
          <span>{i.quantity > 1 && <b>{i.quantity}× </b>}{i.name}</span>
          <span>{brl(i.unitPriceCents * i.quantity)}</span>
        </div>
      ))}
      <div className="ck-item ck-sutil">
        <span>Frete</span>
        <span>{totais.frete === 0 ? "Grátis" : brl(totais.frete)}</span>
      </div>
      <div className="ck-item ck-total">
        <span>Total</span>
        <span>{brl(totais.total)}</span>
      </div>
    </div>
  );
}

function Moldura({ checkout, cor, resumo, children }: {
  checkout: CheckoutPublico; cor: string;
  resumo?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div className="ck-pagina">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <header className="ck-topo">
        {checkout.config.logoUrl
          /* eslint-disable-next-line @next/next/no-img-element */
          ? <img src={checkout.config.logoUrl} alt={checkout.name} className="ck-logo" />
          : <strong style={{ color: cor }}>{checkout.name}</strong>}
      </header>

      <main className={resumo ? "ck-grade" : "ck-grade ck-so"}>
        <div className="ck-cartao">{children}</div>
        {resumo && <aside className="ck-lado">{resumo}</aside>}
      </main>

      <footer className="ck-rodape">
        <span>Compra segura</span>
        {checkout.config.supportEmail && <span> · {checkout.config.supportEmail}</span>}
      </footer>
    </div>
  );
}

/*
 * Estilo próprio, sem os tokens do painel.
 *
 * O painel é escuro e denso porque quem olha para ele passa horas comparando
 * números. Aqui é o contrário: uma pessoa que não conhece a marca precisa
 * confiar em trinta segundos, e checkout escuro num celular no meio da rua
 * atrapalha em vez de ajudar.
 */
const CSS = `
.ck-pagina{min-height:100vh;background:#F4F5F7;color:#111827;
  font-family:"Instrument Sans",system-ui,-apple-system,sans-serif;font-size:15px}
.ck-pagina *{box-sizing:border-box}
.ck-topo{padding:20px 16px;text-align:center;border-bottom:1px solid #E5E7EB;background:#fff}
.ck-logo{max-height:40px;width:auto}
.ck-grade{max-width:980px;margin:0 auto;padding:22px 16px 40px;
  display:grid;grid-template-columns:1fr 330px;gap:22px;align-items:start}
.ck-so{grid-template-columns:1fr;max-width:560px}
.ck-cartao,.ck-lado{background:#fff;border:1px solid #E5E7EB;border-radius:12px;padding:22px}
.ck-lado{position:sticky;top:22px}
.ck-titulo{font-size:13px;text-transform:uppercase;letter-spacing:.06em;
  color:#6B7280;margin:22px 0 12px;font-weight:600}
.ck-titulo:first-child{margin-top:0}
fieldset{border:0;padding:0;margin:0;min-width:0}
fieldset:disabled{opacity:.6}
.ck-campo{display:block;margin-bottom:13px}
.ck-campo>span{display:block;font-size:13px;font-weight:500;margin-bottom:5px;color:#374151}
.ck-campo i{font-style:normal;color:#9CA3AF;font-weight:400}
.ck-campo input,.ck-campo select{width:100%;padding:11px 12px;font-size:15px;
  border:1px solid #D1D5DB;border-radius:8px;background:#fff;color:#111827;font-family:inherit}
.ck-campo input:focus,.ck-campo select:focus{outline:none;border-color:#111827;
  box-shadow:0 0 0 3px rgba(17,24,39,.08)}
.ck-linha{display:grid;grid-template-columns:1fr 1fr;gap:11px}
.ck-metodos{display:flex;gap:9px;margin-bottom:15px}
.ck-metodo{flex:1;padding:12px;border:1.5px solid #D1D5DB;background:#fff;
  border-radius:8px;font-size:14px;font-weight:500;color:#374151}
.ck-ativo{border-width:1.5px;font-weight:600;background:#FAFAFA}
.ck-aviso{font-size:13.5px;color:#4B5563;background:#F9FAFB;border:1px solid #E5E7EB;
  border-radius:8px;padding:12px;margin:0 0 6px}
.ck-botao{width:100%;border:0;border-radius:8px;color:#fff;font-size:16px;
  font-weight:600;padding:14px;margin-top:8px}
.ck-pagar{margin-top:16px}
.ck-erro{background:#FEF2F2;border:1px solid #FECACA;color:#991B1B;
  border-radius:8px;padding:11px 12px;font-size:14px;margin-top:14px}
.ck-seguro{font-size:12px;color:#6B7280;text-align:center;margin:12px 0 0;line-height:1.5}
.ck-item{display:flex;justify-content:space-between;gap:12px;font-size:14px;
  padding:9px 0;border-bottom:1px solid #F3F4F6}
.ck-sutil{color:#6B7280}
.ck-total{border-bottom:0;font-size:17px;font-weight:700;padding-top:13px}
.ck-final{text-align:center;padding:14px 0}
.ck-final h2{font-size:21px;margin:0 0 10px}
.ck-final p{color:#4B5563;line-height:1.6;margin:0 0 10px}
.ck-selo{width:52px;height:52px;border-radius:50%;color:#fff;font-size:26px;
  display:flex;align-items:center;justify-content:center;margin:0 auto 16px}
.ck-qr{width:230px;height:230px;margin:14px auto;display:block;
  border:1px solid #E5E7EB;border-radius:10px;padding:8px;background:#fff}
.ck-emv{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;
  word-break:break-all;background:#F9FAFB;border:1px solid #E5E7EB;border-radius:8px;
  padding:11px;margin:12px 0;text-align:left;color:#374151;max-height:96px;overflow:auto}
.ck-nota{font-size:13px;color:#6B7280}
.ck-espera{display:flex;align-items:center;justify-content:center;gap:7px;margin-top:16px}
.ck-ponto{width:8px;height:8px;border-radius:50%;background:#F59E0B;
  animation:ck-pulsa 1.4s ease-in-out infinite}
@keyframes ck-pulsa{0%,100%{opacity:1}50%{opacity:.25}}
.ck-rodape{text-align:center;font-size:12px;color:#9CA3AF;padding:0 16px 30px}
@media (max-width:820px){
  .ck-grade{grid-template-columns:1fr;padding:14px 12px 30px;gap:14px}
  .ck-lado{position:static;order:-1}
  .ck-cartao,.ck-lado{padding:17px}
}
@media (prefers-reduced-motion:reduce){.ck-ponto{animation:none}}
`;
