import type { NextConfig } from "next";

const config: NextConfig = {
  /* O snippet é servido de /rr.js e precisa de cache longo com revalidação. */
  async headers() {
    return [
      {
        source: "/rr.js",
        headers: [
          { key: "cache-control", value: "public, max-age=300, stale-while-revalidate=86400" },
          { key: "access-control-allow-origin", value: "*" },
        ],
      },
    ];
  },
  /* Caminhos curtos: o site chama /rr/collect, não /api/collect. */
  async rewrites() {
    return [{ source: "/rr/collect", destination: "/api/collect" }];
  },
};

export default config;
