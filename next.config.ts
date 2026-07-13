import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output for Coolify / Hostinger VPS deployment
  // Final artifact: .next/standalone/server.js
  output: "standalone",

  // Catch side-effect bugs in development
  reactStrictMode: true,

  // Fail build on TS errors
  typescript: {
    ignoreBuildErrors: false,
  },

  // Allow cross-origin from preview panel
  allowedDevOrigins: ["*.space-z.ai", "*.z.ai"],

  // Allow remote images from MinIO + production CDN
  images: {
    formats: ["image/avif", "image/webp"],
    remotePatterns: [
      { protocol: "http", hostname: "localhost", port: "9000" },
      { protocol: "https", hostname: "**.taswerak.com" },
      { protocol: "https", hostname: "taswerak.com" },
      { protocol: "https", hostname: "images.unsplash.com" },
      { protocol: "http", hostname: "**.sslip.io" },
      { protocol: "https", hostname: "**.sslip.io" },
    ],
  },

  // Larger body for payment receipt uploads + EXIF images
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },

  // ====================================================================
  // Security headers — applied to ALL routes
  // ====================================================================
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          // Prevent clickjacking
          { key: "X-Frame-Options", value: "DENY" },
          // Prevent MIME-type sniffing
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Control referrer information
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Restrict permissions (camera, mic, geolocation)
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
          },
          // HSTS — force HTTPS (1 year, include subdomains, preload-ready)
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains; preload",
          },
          // Content Security Policy
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              "font-src 'self' https://fonts.gstatic.com data:",
              "img-src 'self' data: blob: https:",
              "media-src 'self' blob: data: https:",
              "connect-src 'self' https://fonts.googleapis.com",
              "frame-ancestors 'none'",
              "form-action 'self'",
              "base-uri 'self'",
              "object-src 'none'",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
