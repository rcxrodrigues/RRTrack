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

  return (
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
  );
}
