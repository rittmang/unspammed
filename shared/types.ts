import { z } from 'zod';
import { defaultPolicy, legacyDefaultPolicy } from './moderation-policy';

export const REPETITION_CONTEXT_MS = 10 * 60 * 1000;

export const settingsSchema = z
  .object({
    mode: z.enum(['observe', 'enforce', 'paused']).default('observe'),
    provider: z.string().min(1).max(60).default('openrouter'),
    model: z.string().min(1).max(200).default('google/gemini-2.5-flash-lite'),
    imageModeration: z.boolean().default(true),
    imageProvider: z.string().min(1).max(60).default('openrouter'),
    imageModel: z.string().max(200).default('google/gemini-2.5-flash-lite'),
    threshold: z.number().min(0.5).max(1).default(0.9),
    reviewThreshold: z.number().min(0).max(1).default(0.6),
    batchSeconds: z.number().int().min(1).max(60).default(10),
    batchSize: z.number().int().min(1).max(30).default(1),
    reasoningTokens: z.number().int().min(0).max(65536).default(1024),
    reasoningMode: z.enum(['default', 'off', 'tokens', 'effort']).optional(),
    reasoningEffort: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{0,39}$/)
      .optional(),
    maxOutputTokens: z.number().int().min(1000).max(262144).optional(),
    modelEndpoint: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_./:-]{0,99}$/)
      .optional(),
    dailyTokenBudget: z.number().int().min(1000).max(10_000_000).default(100_000),
    retentionDays: z.number().int().min(3).max(365).default(30),
    exemptUserIds: z.array(z.string().regex(/^\d+$/)).max(100).default([]),
    policy: z.string().min(20).max(6000).default(defaultPolicy),
  })
  .refine((s) => s.reasoningMode !== 'tokens' || s.reasoningTokens > 0, {
    message: 'Choose a positive thinking token budget.',
  })
  .refine(
    (s) =>
      s.reasoningMode !== 'effort' || Boolean(s.reasoningEffort && s.reasoningEffort !== 'none'),
    {
      message: 'Choose a thinking effort level.',
    },
  )
  .refine(
    (s) =>
      s.reasoningMode !== 'tokens' ||
      !s.maxOutputTokens ||
      s.maxOutputTokens >= s.reasoningTokens + Math.max(1000, s.batchSize * 160),
    {
      message: 'The output limit must leave at least 1,000 tokens beyond the thinking budget.',
    },
  )
  .refine((s) => s.reviewThreshold <= s.threshold, {
    message: 'Review threshold must not exceed enforcement threshold.',
  });
export type Settings = z.infer<typeof settingsSchema>;
export const defaultSettings: Settings = settingsSchema.parse({});
// Old configurations and frozen evaluations predate configurable thinking.
// Reading them must not opt them into the new inference protocol.
export function storedSettings(value: unknown): Settings {
  return settingsSchema.parse({
    batchSize: 20,
    reasoningTokens: 0,
    policy: legacyDefaultPolicy,
    ...z.record(z.string(), z.unknown()).parse(value),
  });
}
export type Label = 'spam' | 'ham' | 'review' | null;
export interface WatchtowerGroup {
  chat_id: string;
  title: string;
  chat_type: string;
  status: 'pending' | 'active' | 'removed' | 'needs_permissions';
  provisioned: number;
  bot_status: string;
  can_delete: number;
  can_ban: number;
  event_at: number;
  event_id: number;
  created_at: number;
  activated_at: number | null;
}
export interface GroupDirectoryResponse {
  groups: WatchtowerGroup[];
  defaultChatId: string;
  botUsername: string;
}
export interface ProviderPublic {
  id: string;
  name: string;
  baseUrl: string;
  configured: boolean;
  format: string;
  reasoning?: import('./reasoning').ReasoningCapabilities;
}
export interface StoredMessage {
  id: number;
  user_id: string;
  user_name: string;
  text: string;
  sent_at: number;
  status: string;
  score: number | null;
  reason: string;
  category: string;
  model: string;
  strike_awarded: number;
  deleted: number;
  label: Label;
  media: string;
  revision: number;
  image_file_id?: string;
  classification_snapshot?: string;
}
export interface UserState {
  user_id: string;
  name: string;
  strikes: number;
  banned: number;
  last_seen: number;
  messages: number;
}
export interface AuditEntry {
  id: number;
  kind: string;
  user_id: string;
  message_id: number | null;
  detail: string;
  created_at: number;
}
export interface Dataset {
  id: string;
  name: string;
  created_at: number;
  count: number;
  labelled: number;
}
export interface Example {
  id: string;
  text: string;
  label: Label;
  userId?: string;
  context?: string[];
  media?: string;
  family?: string;
}
export interface Prediction {
  id: string;
  score: number;
  category: string;
  reason: string;
  needs_review?: boolean;
}
export interface Evaluation {
  next_at?: number;
  retry_attempts?: number;
  id: string;
  dataset_id: string;
  dataset_name: string;
  provider: string;
  model: string;
  status: string;
  cursor: number;
  batch_size: number;
  provider_request_id: string | null;
  total: number;
  input_tokens: number;
  output_tokens: number;
  usage_estimated: number;
  usage_incomplete: number;
  latency_ms: number;
  cost: number | null;
  error: string;
  created_at: number;
  policy: string;
  examples: Example[];
  settings_snapshot?: string;
  predictions: Prediction[];
  reviewLabels?: { id: string; label: Label; updated_at: number }[];
}
export type EvaluationIndex = Omit<Evaluation, 'examples' | 'predictions' | 'reviewLabels'> & {
  snapshot_key: string;
};
export interface EvaluationPage {
  examples?: Example[];
  predictions?: Prediction[];
  reviewLabels?: Evaluation['reviewLabels'];
  nextOffset: number | null;
}
export interface Overview {
  storage?: {
    backend: 'sqlite' | 'postgres';
    ready: boolean;
    status?: 'waiting_source' | 'copying' | 'complete' | 'cancelled';
    copied?: number;
    total?: number;
    error?: string;
  };
  settings: Settings;
  providers: ProviderPublic[];
  dev: boolean;
  chatId: string;
  owner: string;
  stats: {
    total: number;
    spam: number;
    deleted: number;
    banned: number;
    pending: number;
    review: number;
    tokens: number;
    labTokens: number;
    failures: number;
  };
  daily: { day: string; total: number; spam: number }[];
  messages: StoredMessage[];
  users: UserState[];
  audit: AuditEntry[];
}
