import { CarregarPlataforma } from "@/ui/carregar-plataforma";

export const dynamic = "force-dynamic";

export default async function Pagina({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <CarregarPlataforma plataforma="meta" titulo="Meta" busca={await searchParams} />;
}
