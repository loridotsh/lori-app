import path from "node:path";
import type { NextConfig } from "next";

const workspaceRoot = path.join(import.meta.dirname, "../..");

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: workspaceRoot,
  // The dev-only build badge floats over the bottom of the Work sidebar.
  devIndicators: false,
  poweredByHeader: false,
  reactStrictMode: true,
  turbopack: {
    root: workspaceRoot,
  },
};

export default nextConfig;
