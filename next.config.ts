import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  turbopack: {
	root: path.join(__dirname),
  },
  allowedDevOrigins: ['100.104.99.50'],
};

export default nextConfig;
