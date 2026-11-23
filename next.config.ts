import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  output: "standalone",
  // pg is a server-only dependency; keep it out of the bundler.
  serverExternalPackages: ["pg"],
  // documents up to 15 MB are uploaded through server actions
  experimental: { serverActions: { bodySizeLimit: "16mb" } },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "camera=(self), geolocation=(), microphone=()" },
          ...(isProd ? [
            { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
            // no outside scripts, frames or form targets; Next.js needs inline scripts without a nonce
            { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
          ] : []),
        ],
      },
    ];
  },
};

export default nextConfig;
