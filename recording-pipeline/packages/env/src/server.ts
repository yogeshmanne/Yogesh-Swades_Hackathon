import { z } from "zod";

const serverEnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  BUCKET_ENDPOINT: z.string().url(),
  BUCKET_ACCESS_KEY: z.string().min(1),
  BUCKET_SECRET_KEY: z.string().min(1),
  BUCKET_NAME: z.string().min(1),
  TRANSCRIBE_PROVIDER: z.enum(["deepgram"]).default("deepgram"),
  DEEPGRAM_API_KEY: z.string().min(1),
  TRANSCRIBE_LANGUAGE: z.string().default("en"),
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

export const serverEnv = serverEnvSchema.parse(process.env);
