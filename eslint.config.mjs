import next from "eslint-config-next";

const nextConfig = Array.isArray(next) ? next : [next];

const config = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "legacy/**",
      "scripts/**",
      "prisma/migrations/**",
    ],
  },
  ...nextConfig,
];

export default config;
