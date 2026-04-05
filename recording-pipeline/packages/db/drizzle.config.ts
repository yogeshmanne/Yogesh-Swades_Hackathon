import type { Config } from "drizzle-kit";
import * as dotenv from "dotenv";
dotenv.config({ path: "../../apps/server/.env" });

export default {
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
} satisfies Config;
