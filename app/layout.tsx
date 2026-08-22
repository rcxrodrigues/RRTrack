export const metadata = {
  title: "RRTrack",
  description: "Servidor de atribuição e conversões",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
