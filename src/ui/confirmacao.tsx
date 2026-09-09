"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/*
 * A confirmação de que gravou.
 *
 * Existe porque quase toda tela daqui salvava em silêncio: o formulário
 * fechava, a lista se refazia, e quem clicou tinha que DEDUZIR pelo resultado
 * que deu certo. Onde o efeito aparece na mesma tela isso quase passa; onde
 * não aparece — taxa do gateway, produto da página, fuso da loja — não há o
 * que deduzir, e a única saída é atualizar a página para conferir.
 *
 * Some sozinha depois de alguns segundos, de propósito. Confirmação que fica
 * na tela para de ser confirmação: na edição seguinte ela ainda está lá,
 * dizendo que gravou uma coisa que ninguém gravou.
 *
 * O texto padrão é o mesmo em toda parte. Quem tem algo a mais para contar
 * — quantas vendas foram recalculadas, por exemplo — passa o seu.
 */

const SEGUNDOS = 5;

export function useConfirmacao() {
  const [confirmacao, setConfirmacao] = useState<string | null>(null);
  const relogio = useRef<ReturnType<typeof setTimeout> | null>(null);

  /*
   * Desmontou, cancela. Sem isto o temporizador chama `setConfirmacao` num
   * componente que não existe mais — e como quase toda tela daqui abre e
   * fecha diálogo, seriam vários pendurados ao mesmo tempo.
   */
  useEffect(() => () => {
    if (relogio.current) clearTimeout(relogio.current);
  }, []);

  const confirmar = useCallback((texto = "Alterações salvas com sucesso.") => {
    if (relogio.current) clearTimeout(relogio.current);
    setConfirmacao(texto);
    relogio.current = setTimeout(() => setConfirmacao(null), SEGUNDOS * 1000);
  }, []);

  /* Chamado no começo de cada gravação: a confirmação da anterior não pode
     ficar na tela enquanto a nova ainda está em voo. */
  const limpar = useCallback(() => {
    if (relogio.current) clearTimeout(relogio.current);
    setConfirmacao(null);
  }, []);

  return { confirmacao, confirmar, limpar };
}

/**
 * A faixa verde. `role="status"` para que leitor de tela anuncie sem roubar o
 * foco — quem acabou de clicar em Salvar continua onde estava.
 */
export function Confirmacao({ texto, margemAbaixo = 12 }: {
  texto: string | null;
  margemAbaixo?: number;
}) {
  if (!texto) return null;
  return (
    <div role="status" style={{
      display: "flex", alignItems: "center", gap: 7,
      background: "var(--positivo-fundo)", border: "1px solid var(--positivo)",
      borderRadius: 6, padding: "9px 13px", marginBottom: margemAbaixo,
      fontSize: 12.5, color: "var(--positivo)", maxWidth: 700,
    }}>
      <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor"
        strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
        style={{ flexShrink: 0 }}>
        <path d="M4 10.5l4 4 8-9" />
      </svg>
      {texto}
    </div>
  );
}
