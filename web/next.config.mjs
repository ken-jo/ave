/** @type {import('next').NextConfig} */
import { DocumentDependencyPlugin } from '../scripts/lib/document-consumer-guard.mjs';

const nextConfig = {
  output: 'export',
  images: { unoptimized: true },
  trailingSlash: true,
  reactStrictMode: true,
  webpack(config) {
    config.plugins.push(new DocumentDependencyPlugin());
    // lib/providers.ts reads the app's provider list from ../src, whose ESM
    // imports name the compiled ".js" file of a ".ts" source.
    config.resolve.extensionAlias = { ...config.resolve.extensionAlias, ".js": [".ts", ".tsx", ".js"] };
    return config;
  },
};

export default nextConfig;
