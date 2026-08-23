import "./globals.css";

export const metadata = {
  title: "RRTrack",
  description: "Rastreamento e atribuição",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
