/**
 * Telemetry join: promptfoo results -> Langfuse traces.
 *
 * ChatFullResponse carries no token counts and no latency. Langfuse has both, but this
 * deployment runs Langfuse v4 in `events_only` mode, where /api/public/traces,
 * /observations, /sessions and /scores all return "not available on deployments running
 * in Langfuse v4 events_only mode". So reads go to ClickHouse directly.
 *
 * The join key needs no run id and no Onyx code change: the tracing processor maps
 * `chat_session_id` onto the Langfuse `session_id` facet
 * (tracing/langfuse_tracing_processor.py:83-99), and ChatFullResponse returns
 * `chat_session_id`. One session per case gives an exact 1:1 join.
 */

export interface ClickHouseConfig {
  url: string;
  user: string;
  password: string;
  database: string;
  projectId: string;
}

export interface SessionTelemetry {
  session_id: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  latency_ms: number;
  /** Every distinct model across every span of the session. */
  models: string[];
  spans: string[];
  generation_count: number;
}

export function clickHouseConfigFromEnv(env = process.env): ClickHouseConfig {
  const password = env.CLICKHOUSE_PASSWORD;
  if (!password) {
    throw new Error(
      'CLICKHOUSE_PASSWORD is not set. Read it with:\n' +
        '  docker exec langfuse-langfuse-web-1 printenv CLICKHOUSE_PASSWORD',
    );
  }
  return {
    url: env.CLICKHOUSE_URL ?? 'http://127.0.0.1:8124',
    user: env.CLICKHOUSE_USER ?? 'clickhouse',
    password,
    database: env.CLICKHOUSE_DATABASE ?? 'default',
    projectId: env.LANGFUSE_PROJECT_ID ?? 'onyx',
  };
}

/** ClickHouse string literal escaping. Session ids are UUIDs, but never interpolate raw. */
function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export async function query<T>(cfg: ClickHouseConfig, sql: string): Promise<T[]> {
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${cfg.user}:${cfg.password}`).toString('base64')}`,
      'Content-Type': 'text/plain; charset=utf-8',
    },
    body: `${sql} FORMAT JSONEachRow`,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickHouse query failed (HTTP ${res.status}): ${text.slice(0, 400)}`);
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as T);
}

/**
 * Per-session token counts, latency and the models actually used.
 *
 * `models` is the llm_override verification. One override is supposed to cover the whole
 * cascade — query expansion, the time filter and relevance classification all run on the
 * same LLM instance (search_tool.py:305 stores it once; :628, :636, :802, :1111, :1173
 * all read `self.llm`). If more than the requested model appears here, the model axis is
 * mislabelled.
 */
export async function fetchSessionTelemetry(
  cfg: ClickHouseConfig,
  sessionIds: string[],
  excludeModels: string[] = [],
): Promise<SessionTelemetry[]> {
  if (sessionIds.length === 0) return [];
  const ids = sessionIds.map(quote).join(', ');
  // The embedding model emits its own zero-token GENERATION spans under the same
  // trace_name (27 of them in the reference deployment). It is set by the search
  // settings, not by llm_override, so it must not count toward the model check.
  const excluded = excludeModels.length
    ? `AND provided_model_name NOT IN (${excludeModels.map(quote).join(', ')})`
    : '';
  const sql = `
    SELECT
      session_id,
      toUInt64(sum(usage_details['input']))  AS prompt_tokens,
      toUInt64(sum(usage_details['output'])) AS completion_tokens,
      toUInt64(sum(usage_details['total']))  AS total_tokens,
      toUInt64(max(dateDiff('millisecond', start_time, end_time))) AS latency_ms,
      arrayFilter(x -> x != '', groupUniqArray(provided_model_name)) AS models,
      groupUniqArray(name) AS spans,
      toUInt64(countIf(type = 'GENERATION')) AS generation_count
    FROM ${cfg.database}.events_full
    WHERE project_id = ${quote(cfg.projectId)}
      AND trace_name = 'run_llm_loop'
      AND session_id IN (${ids})
      ${excluded}
    GROUP BY session_id`;
  return query<SessionTelemetry>(cfg, sql);
}

/**
 * Langfuse ingestion is asynchronous, so wait for every session to land before
 * aggregating. Returns whatever is present at the deadline rather than throwing — a
 * missing trace is a reportable result, not a reason to lose the eval run.
 */
export async function waitForSessions(
  cfg: ClickHouseConfig,
  sessionIds: string[],
  {
    intervalMs = 5000,
    timeoutMs = 60_000,
    excludeModels = [],
  }: { intervalMs?: number; timeoutMs?: number; excludeModels?: string[] } = {},
): Promise<{ telemetry: SessionTelemetry[]; missing: string[] }> {
  const deadline = Date.now() + timeoutMs;
  let telemetry: SessionTelemetry[] = [];
  for (;;) {
    telemetry = await fetchSessionTelemetry(cfg, sessionIds, excludeModels);
    const seen = new Set(telemetry.map((t) => t.session_id));
    const missing = sessionIds.filter((id) => !seen.has(id));
    if (missing.length === 0 || Date.now() >= deadline) return { telemetry, missing };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** The composed system prompt for a session, straight off the generation span. */
export async function fetchLlmLoopInput(
  cfg: ClickHouseConfig,
  sessionId: string,
): Promise<{ input: string; tool_call_names: string[]; tool_definitions: Record<string, string> } | null> {
  const rows = await query<{
    input: string;
    tool_call_names: string[];
    tool_definitions: Record<string, string>;
  }>(
    cfg,
    `SELECT input, tool_call_names, tool_definitions
     FROM ${cfg.database}.events_full
     WHERE project_id = ${quote(cfg.projectId)}
       AND trace_name = 'run_llm_loop'
       AND type = 'GENERATION'
       AND session_id = ${quote(sessionId)}
     ORDER BY start_time ASC
     LIMIT 1`,
  );
  return rows[0] ?? null;
}

/**
 * Cascade coverage across a multi-model run.
 *
 * One `llm_override` is supposed to carry the whole search cascade — query expansion, the
 * time filter, relevance classification — not just the answer. With more than one model on
 * the axis the check cannot be "every span used model X": each session should be internally
 * homogeneous and should have used one of the models we asked for.
 *
 * A session reporting two different models is the failure that would mislabel the axis, and
 * it is reported by name rather than folded into a boolean.
 */
export function cascadeCoverage(
  telemetry: SessionTelemetry[],
  expectedModels: string[],
): { covered: boolean; perModel: Record<string, number>; offenders: string[] } {
  const matches = (m: string, want: string) => m === want || m.endsWith(`/${want}`);
  const perModel: Record<string, number> = {};
  const offenders: string[] = [];

  for (const t of telemetry) {
    const want = expectedModels.find((w) => t.models.some((m) => matches(m, w)));
    const homogeneous = t.models.length > 0 && want !== undefined &&
      t.models.every((m) => matches(m, want));
    if (homogeneous && want) perModel[want] = (perModel[want] ?? 0) + 1;
    else offenders.push(`${t.session_id ?? "?"} saw [${t.models.join(", ")}]`);
  }
  return { covered: telemetry.length > 0 && offenders.length === 0, perModel, offenders };
}


/**
 * Pull the system prompt out of a generation span's `input`.
 *
 * `input` is a JSON document whose newlines are escaped, so matching line patterns
 * against the raw string silently runs past every line break — `/User name:\s*(.*)/`
 * captures the rest of the document rather than the rest of the line. Parse first, then
 * assert against real text.
 */
export function systemPromptFrom(input: string): string {
  try {
    const parsed = JSON.parse(input) as {
      messages?: { role?: string; content?: unknown }[];
    };
    const system = (parsed.messages ?? []).find((m) => m.role === 'system');
    if (typeof system?.content === 'string') return system.content;
  } catch {
    /* fall through to the raw string */
  }
  return input;
}
