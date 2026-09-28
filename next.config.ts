import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PDF / Word text extraction libraries run on the server as plain Node packages.
  serverExternalPackages: ["unpdf", "mammoth"],
  experimental: {
    // proxy.ts buffers request bodies; allow large attachments (images, big files).
    proxyClientMaxBodySize: "200mb",
  },
};

export default nextConfig;
