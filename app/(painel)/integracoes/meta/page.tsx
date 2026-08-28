import { redirect } from "next/navigation";
import { contexto } from "@/core/sessao";
import { MetaVincular } from "@/ui/meta-vincular";

export const dynamic = "force-dynamic";

/*
 * A tela em si não lê nada do banco: tudo que ela mostra vem da Meta, com o
 * token que ainda está no cookie do vínculo em andamento. Se o cookie tiver
 * vencido, a própria tela diz isso e oferece recomeçar.
 */
export default async function PaginaVincularMeta() {
  const ctx = await contexto();
  if (!ctx) redirect("/entrar");

  return <MetaVincular />;
}
