import type { z } from "zod";
import {
  initializeRequestSchema,
  type RuntimeConfig,
} from "@/runtime/types";

export type InitializeRequest = z.infer<typeof initializeRequestSchema>;
export type { RuntimeConfig };
