import { z } from "zod";

const telegramGroupSchema = z.object({
  enabled: z.boolean().default(true),
  allowFrom: z.array(z.string()).optional(),
});

const telegramChannelSchema = z.object({
  botToken: z.string().min(1, "botToken is required"),
  dmPolicy: z.enum(["open", "pairing", "allowlist", "disabled"]).default("pairing"),
  groupPolicy: z.enum(["open", "pairing", "allowlist", "disabled"]).default("disabled"),
  allowFrom: z.array(z.string()).default([]),
  groups: z.record(z.string(), telegramGroupSchema).default({}),
});

const gatewaySchema = z.object({
  port: z.number().int().positive().default(18790),
  dataDir: z.string().default("~/.opencodex"),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  logFormat: z.enum(["pretty", "json"]).default("pretty"),
});

const legacyClaudeSchema = z.object({
  binary: z.string().default("claude"),
  model: z.string().optional(),
  idleTimeoutMs: z.number().int().positive().default(600000),
  maxProcesses: z.number().int().positive().default(10),
  extraArgs: z.array(z.string()).default([]),
});

const codexEngineSchema = z.object({
  binary: z.string().default("codex"),
  model: z.string().nullable().optional().transform((v) => v ?? undefined),
  sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("danger-full-access"),
  approvalPolicy: z.enum(["untrusted", "on-request", "never"]).default("never"),
  extraArgs: z.array(z.string()).default([]),
});

const claudeEngineSchema = z.object({
  binary: z.string().default("claude"),
  model: z.string().optional(),
  extraArgs: z.array(z.string()).default([]),
});

const engineSchema = z.object({
  type: z.enum(["codex", "claude"]).default("codex"),
  maxProcesses: z.number().int().positive().default(10),
  idleTimeoutMs: z.number().int().positive().default(600000),
  codex: codexEngineSchema.default(codexEngineSchema.parse({})),
  claude: claudeEngineSchema.default(claudeEngineSchema.parse({})),
});

const claudeSchema = legacyClaudeSchema;

const authSchema = z.object({
  defaultPolicy: z.enum(["open", "pairing", "allowlist", "disabled"]).default("pairing"),
});

const channelsSchema = z.object({
  telegram: telegramChannelSchema.optional(),
});

const botAuthSchema = z.object({
  dmPolicy: z.enum(["open", "pairing", "allowlist", "disabled"]).optional(),
  groupPolicy: z.enum(["open", "pairing", "allowlist", "disabled"]).optional(),
  allowFrom: z.array(z.string()).optional(),
  groups: z.record(z.string(), telegramGroupSchema).optional(),
});

const botSchema = z.object({
  name: z.string().min(1, "bot name is required"),
  token: z.string().min(1, "bot token is required"),
  model: z.string().optional(),
  extraArgs: z.array(z.string()).optional(),
  auth: botAuthSchema.optional(),
});

export const configSchema = z.preprocess((input) => {
  const raw = (input ?? {}) as Record<string, unknown>;
  const legacyClaude = raw.claude as Record<string, unknown> | undefined;
  const engine = { ...((raw.engine as Record<string, unknown> | undefined) ?? {}) };

  if (legacyClaude) {
    engine.maxProcesses ??= legacyClaude.maxProcesses;
    engine.idleTimeoutMs ??= legacyClaude.idleTimeoutMs;
    const engineClaude = {
      ...((engine.claude as Record<string, unknown> | undefined) ?? {}),
    };
    if (legacyClaude.binary !== undefined) engineClaude.binary ??= legacyClaude.binary;
    if (legacyClaude.model !== undefined) engineClaude.model ??= legacyClaude.model;
    if (legacyClaude.extraArgs !== undefined) engineClaude.extraArgs ??= legacyClaude.extraArgs;
    engine.claude = engineClaude;
  }

  return { ...raw, engine };
}, z.object({
  gateway: gatewaySchema.default(gatewaySchema.parse({})),
  engine: engineSchema.default(engineSchema.parse({})),
  claude: claudeSchema.default(claudeSchema.parse({})),
  auth: authSchema.default(authSchema.parse({})),
  channels: channelsSchema.optional(),
  bots: z.array(botSchema).optional(),
}));
