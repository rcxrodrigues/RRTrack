"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/*
 * Mantém a tela viva sem recarregar a página.
 *
 * Chama `router.refresh()`, que reexecuta só as consultas do servidor e troca
 * os números no lugar — sem piscar, sem perder rolagem, sem perder o filtro
 * que você escolheu.
 *
 * Isto atualiza o que JÁ ESTÁ no nosso banco, e é de graça: é uma consulta ao
 * Postgres, não uma chamada para plataforma nenhuma. Como a venda chega por
 * webhook no instante em que o gateway avisa, o efeito prático é que
 * faturamento, vendas e funil ficam praticamente ao vivo.
 *
 * O gasto é outra história e não vem por aqui — ver a sincronização por
 * obsolescência em carregar-plataforma.
 */

export function AutoAtualiza({ segundos = 30 }: { segundos?: number }) {
  const router = useRouter();
  const [desde, setDesde] = useState(0);
  const [pausado, setPausado] = useState(false);

  useEffect(() => {
    const contador = setInterval(() => setDesde((s) => s + 1), 1000);
    return () => clearInterval(contador);
  }, []);

  useEffect(() => {
    if (pausado) return;

    const t = setInterval(() => {
      /*
       * Aba escondida não atualiza. Painel aberto em segundo plano a semana
       * inteira faria milhares de consultas para ninguém ler — e o navegador
       * estrangula temporizador de aba oculta de qualquer jeito, então o
       * intervalo nem seria respeitado.
       */
      if (document.visibilityState !== "visible") return;
      router.refresh();
      setDesde(0);
    }, segundos * 1000);

    return () => clearInterval(t);
  }, [router, segundos, pausado]);

  /*
   * Voltar para a tela atualiza NA HORA, sem esperar o ciclo.
   *
   * É o que faltava no atalho salvo na tela inicial do iPhone: o iOS congela
   * a página quando você sai do app, o temporizador não roda, e ao voltar a
   * tela mostrava o número de antes até o próximo ciclo completar. Como não
   * há barra de endereço ali, não havia nem como recarregar — o painel
   * simplesmente discordava do que o navegador do computador mostrava.
   *
   * Serve para o computador também: trocar de aba e voltar traz o número
   * atual, que é exatamente quando alguém olha.
   */
  useEffect(() => {
    if (pausado) return;

    function aoVoltar() {
      if (document.visibilityState !== "visible") return;
      router.refresh();
      setDesde(0);
    }

    document.addEventListener("visibilitychange", aoVoltar);
    /* `pageshow` cobre o cache de volta-e-avança, que não dispara o de cima. */
    window.addEventListener("pageshow", aoVoltar);
    return () => {
      document.removeEventListener("visibilitychange", aoVoltar);
      window.removeEventListener("pageshow", aoVoltar);
    };
  }, [router, pausado]);

  function atualizarAgora() {
    router.refresh();
    setDesde(0);
  }

  return (
    <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
    <button
      onClick={atualizarAgora}
      title="Atualizar agora"
      aria-label="Atualizar agora"
      style={{
        display: "flex", alignItems: "center",
        background: "none", border: "none", padding: 0,
        color: "var(--ink-tenue)", cursor: "pointer",
      }}
    >
      {/*
        Botão de atualizar, que só faz sentido depois do atalho no iPhone: sem
        barra de endereço, não existia gesto nenhum para forçar a atualização.
      */}
      <svg width="12" height="12" viewBox="0 0 20 20" fill="none"
        stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M17 10a7 7 0 1 1-2.05-4.95" />
        <path d="M17 3v4h-4" />
      </svg>
    </button>
    <button
      onClick={() => setPausado((p) => !p)}
      title={pausado ? "Retomar atualização automática" : "Pausar atualização automática"}
      style={{
        display: "flex", alignItems: "center", gap: 6,
        background: "none", border: "none", padding: 0,
        fontSize: 11, color: "var(--ink-tenue)",
      }}
    >
      <span style={{
        width: 6, height: 6, borderRadius: "50%",
        background: pausado ? "var(--ink-tenue)" : "var(--positivo)",
        boxShadow: pausado ? "none" : "0 0 7px var(--positivo)",
      }} />
      <span className="num">
        {pausado ? "pausado" : desde < 5 ? "agora mesmo" : `há ${desde}s`}
      </span>
    </button>
    </span>
  );
}
