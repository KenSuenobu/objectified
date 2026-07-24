import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Yarn workspaces hoist dependencies to the repo root; Turbopack must use the
// same root (not infer it from stray package-lock.json files in the monorepo).
const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.resolve(packageRoot, "..");

// Comma-separated hostnames/IPs allowed to load dev assets (/_next/webpack-hmr, etc.)
// when the UI is opened from a non-localhost origin (e.g. http://10.0.0.96:3000 on LAN).
// Example: NEXT_ALLOWED_DEV_ORIGINS=10.0.0.96,192.168.1.42
const allowedDevOrigins = (process.env.NEXT_ALLOWED_DEV_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  reactCompiler: true,
  // Enable standalone output for Docker
  output: "standalone",
  outputFileTracingRoot: monorepoRoot,
  ...(allowedDevOrigins.length > 0 ? { allowedDevOrigins } : {}),
  turbopack: {
    root: monorepoRoot,
  },
  experimental: {
    cpus: 4,
    memoryBasedWorkersCount: true,
  },
};

export default nextConfig;
