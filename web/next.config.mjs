/** @type {import('next').NextConfig} */
import { DocumentDependencyPlugin } from '../scripts/lib/document-consumer-guard.mjs';

const nextConfig = {
  output: 'export',
  images: { unoptimized: true },
  trailingSlash: true,
  reactStrictMode: true,
  webpack(config) {
    config.plugins.push(new DocumentDependencyPlugin());
    return config;
  },
};

export default nextConfig;
