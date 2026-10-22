import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  serverExternalPackages: [
    "@mastra/libsql",
    "@libsql/client",
    "libsql",
    "@mastra/duckdb",
    "@duckdb/node-api",
    "@duckdb/node-bindings",
    "duckdb",
  ],
};

export default nextConfig;
