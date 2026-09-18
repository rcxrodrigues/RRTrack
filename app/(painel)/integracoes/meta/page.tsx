import { redirect } from "next/navigation";
import { contexto } from "@/core/sessao";
import { MetaVincular } from "@/ui/meta-vincular";

export const dynamic = "force-dynamic";

/*
 * A tela em si não lê nada do banco: tudo que ela mostra vem da Meta, com o
 * token do perfil conectado — que vive em `meta_profiles`, cifrado, e é
 * buscado pela rota /api/meta/vincular. Não é mais cookie: o vínculo precisa
 * atravessar navegador antidetect, e cookie não atravessa. Sem perfil
 * conectado, a própria tela diz isso e oferece recomeçar.
 */
export default async function PaginaVincularMeta() {
  const ctx = await contexto();
  if (!ctx) redirect("/entrar");

  return <MetaVincular />;
}
