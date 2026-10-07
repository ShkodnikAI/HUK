import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin();

const nextConfig: NextConfig = {
  // "/" redirects to the default locale (no middleware — Node-only, H-109).
  async redirects() {
    return [{ source: "/", destination: "/en", permanent: false }];
  },
};

export default withNextIntl(nextConfig);
