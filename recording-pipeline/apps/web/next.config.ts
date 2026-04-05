import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@repo/env"],
};

export default nextConfig;
