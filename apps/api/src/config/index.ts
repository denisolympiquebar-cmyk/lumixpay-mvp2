import dotenv from "dotenv";
import path from "path";

// Uvijek učitaj .env iz repo root-a (2 nivoa iznad src/)
dotenv.config({ path: path.resolve(process.cwd(), "../..", ".env") });

function require_env(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

export const config = {
  port: parseInt(process.env["PORT"] ?? "4000", 10),
  nodeEnv: process.env["NODE_ENV"] ?? "development",

  db: {
    connectionString:
      process.env["DATABASE_URL"] ??
      `postgresql://${process.env["POSTGRES_USER"] ?? "lumixpay"}:${process.env["POSTGRES_PASSWORD"] ?? "lumixpay_secret"}@${process.env["POSTGRES_HOST"] ?? "localhost"}:${process.env["POSTGRES_PORT"] ?? "5432"}/${process.env["POSTGRES_DB"] ?? "lumixpay"}`,
  },

  jwt: {
    secret: process.env["JWT_SECRET"] ?? "change_this_secret",
    expiresIn: process.env["JWT_EXPIRES_IN"] ?? "24h",
  },

  fee: {
    rate: parseFloat(process.env["PLATFORM_FEE_RATE"] ?? "0.01"),
  },

  system: {
    userId: "00000000-0000-0000-0001-000000000000",
    accounts: {
      rlusd: {
        assetId: "00000000-0000-0000-0000-000000000001",
        // FLOAT_RLUSD — on-chain reserve; debited on top-up, credited on withdrawal settlement
        float: "00000000-0001-0000-0000-000000000001",
        feeCollector: "00000000-0001-0000-0000-000000000002",
        withdrawalEscrow: "00000000-0001-0000-0000-000000000003",
      },
      eurq: {
        assetId: "00000000-0000-0000-0000-000000000002",
        // FLOAT_EURQ — on-chain reserve; debited on top-up, credited on withdrawal settlement
        float: "00000000-0002-0000-0000-000000000001",
        feeCollector: "00000000-0002-0000-0000-000000000002",
        withdrawalEscrow: "00000000-0002-0000-0000-000000000003",
      },
    },
  },
} as const;

export type Config = typeof config;
