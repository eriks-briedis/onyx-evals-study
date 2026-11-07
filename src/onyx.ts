/**
 * Typed HTTP client for the Onyx routes this suite uses.
 *
 * Deliberately standalone: the wire formats were read out of
 * backend/tests/integration/common_utils/managers/ and reimplemented here, so the
 * suite stays black-box and carries no dependency on the Onyx Python package.
 *
 * Note that backend/tests/integration/common_utils/chat.py and
 * backend/scripts/api_inference_sample.py are stale — they still send the removed
 * fields `prompt_id`, `retrieval_options` and `stream_response`. The current shape is
 * backend/scripts/run_enterpriserag_bench_questions.py:402.
 */
import type {
  CcPairInfo,
  ChatFullResponse,
  DocMinimalInfo,
  DocumentSetSummary,
  FileUploadResponse,
  IndexAttempt,
  IndexingStatus,
  LlmProvider,
  MeResponse,
  PersonaSnapshot,
  SearchSettings,
  ToolSnapshot,
  WorkspaceSettings,
} from './types.js';

export class OnyxError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
  ) {
    super(`${path} -> HTTP ${status}: ${body.slice(0, 400)}`);
    this.name = 'OnyxError';
  }
}

/**
 * Two ways to authenticate.
 *
 * `apiKey` is the documented path, but `POST /admin/api-key` sits behind the Business
 * tier gate (ee/onyx/server/middleware/tier_gate.py, `/admin/api-key -> BUSINESS`), so a
 * Community deployment cannot mint one at all.
 *
 * Cookie login is not gated: `/auth` is in LICENSE_ENFORCEMENT_ALLOWED_PREFIXES, and so
 * is every route this suite needs. Use a dedicated eval user, never a human's account —
 * the hygiene step wipes the caller's name, role, memories and preferences.
 */
export type OnyxAuth =
  | { kind: 'apiKey'; apiKey: string }
  | { kind: 'password'; email: string; password: string };

export interface SendMessageOptions {
  message: string;
  personaId: number;
  documentSets?: string[];
  modelConfigurationId?: number;
  temperature?: number;
  /**
   * Restricts the toolset for this request. Leave unset in the main arm.
   * MemoryTool ignores it entirely — tool_constructor.py:518 injects that one
   * bypassing both persona tool associations and allowed_tool_ids.
   */
  allowedToolIds?: number[];
}

export class OnyxClient {
  private readonly base: string;
  private cookie: string | null = null;

  constructor(
    baseUrl: string,
    private readonly auth: OnyxAuth,
  ) {
    // nginx proxies /api/* to the API server.
    this.base = `${baseUrl.replace(/\/+$/, '')}/api`;
  }

  /**
   * Exchange email + password for a `fastapiusersauth` cookie. Idempotent: a client
   * already holding a cookie is left alone. No-op under API key auth.
   */
  async login(): Promise<void> {
    if (this.auth.kind !== 'password' || this.cookie) return;

    const form = new URLSearchParams({
      username: this.auth.email,
      password: this.auth.password,
    });
    const res = await fetch(`${this.base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    if (!res.ok) {
      throw new OnyxError(res.status, 'POST /auth/login', await res.text());
    }

    const raw = res.headers.getSetCookie?.() ?? [];
    const jar = raw.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
    if (!jar) {
      throw new Error('Login succeeded but returned no Set-Cookie header.');
    }
    this.cookie = jar;
  }

  /**
   * Auth headers for this client's credentials.
   *
   * Public because promptfoo's `http` provider issues its own requests and knows nothing
   * about this client's session. The setup hook copies these onto each provider; without
   * that, every eval request goes out unauthenticated and Onyx answers 403, which then
   * surfaces confusingly as a transform error on `output.answer`.
   */
  authHeaders(): Record<string, string> {
    if (this.auth.kind === 'apiKey') {
      return { Authorization: `Bearer ${this.auth.apiKey}` };
    }
    return this.cookie ? { Cookie: this.cookie } : {};
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    { raw = false }: { raw?: boolean } = {},
  ): Promise<T> {
    await this.login();
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        ...this.authHeaders(),
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (!res.ok) throw new OnyxError(res.status, `${method} ${path}`, text);
    if (raw || text === '') return text as unknown as T;
    return JSON.parse(text) as T;
  }

  /** Multipart POST. fetch sets the boundary itself, so no Content-Type header here. */
  private async postForm<T>(path: string, form: FormData): Promise<T> {
    await this.login();
    const res = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: form,
    });
    const text = await res.text();
    if (!res.ok) throw new OnyxError(res.status, `POST ${path}`, text);
    return JSON.parse(text) as T;
  }

  /** Grant or revoke admin. Requires the CALLER to be admin. Never tier-gated. */
  setAdminAccess(userEmail: string, isAdmin: boolean): Promise<unknown> {
    return this.request('PATCH', '/manage/admin/users/admin-access', {
      user_email: userEmail,
      is_admin: isAdmin,
    }, { raw: true });
  }

  /** Register a new user. `/auth` is never tier-gated. */
  async register(email: string, password: string): Promise<{ created: boolean }> {
    const res = await fetch(`${this.base}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, username: email, password }),
    });
    if (res.ok) return { created: true };
    const text = await res.text();
    // Already registered is the expected outcome on a re-run.
    if (res.status === 400 && /already exists|REGISTER_USER_ALREADY_EXISTS/i.test(text)) {
      return { created: false };
    }
    throw new OnyxError(res.status, 'POST /auth/register', text);
  }

  /** Unauthenticated reachability probe. Returns 200 even without a key. */
  async health(): Promise<boolean> {
    const res = await fetch(`${this.base}/health`);
    return res.ok;
  }

  getMe(): Promise<MeResponse> {
    return this.request<MeResponse>('GET', '/me');
  }

  /**
   * Acts on the *calling* user (server/manage/users.py:1313) — there is no admin route
   * to set another user's flags, and no API route to create a user at all. The API key
   * has its own SERVICE_ACCOUNT user row (db/api_key.py:148) which sets neither memory
   * flag, so both start at the column default `true`.
   *
   * Every field is None-defaulted server-side and applied only when present, so this
   * is safe to call repeatedly.
   */
  patchPersonalization(patch: {
    name?: string;
    role?: string;
    use_memories?: boolean;
    enable_memory_tool?: boolean;
    memories?: unknown[];
    user_preferences?: string;
  }): Promise<unknown> {
    return this.request('PATCH', '/user/personalization', patch);
  }

  listTools(): Promise<ToolSnapshot[]> {
    return this.request<ToolSnapshot[]>('GET', '/tool');
  }

  listDocumentSets(): Promise<DocumentSetSummary[]> {
    // Note: no /admin on the read path.
    return this.request<DocumentSetSummary[]>('GET', '/manage/document-set');
  }

  /** Returns the new document set id as a bare integer. */
  createDocumentSet(args: {
    name: string;
    description: string;
    cc_pair_ids: number[];
  }): Promise<number> {
    return this.request<number>('POST', '/manage/admin/document-set', {
      ...args,
      is_public: true,
      users: [],
      groups: [],
      federated_connectors: [],
    });
  }

  /** Replaces the set's cc_pairs. Like creation, this only enqueues the index sync. */
  updateDocumentSet(args: {
    id: number;
    name: string;
    description: string;
    cc_pair_ids: number[];
  }): Promise<unknown> {
    return this.request('PATCH', '/manage/admin/document-set', {
      ...args,
      is_public: true,
      users: [],
      groups: [],
      federated_connectors: [],
    }, { raw: true });
  }

  listPersonas(): Promise<PersonaSnapshot[]> {
    return this.request<PersonaSnapshot[]>('GET', '/admin/persona');
  }

  /**
   * `name`, `description`, `document_set_ids`, `tool_ids`, `system_prompt`,
   * `task_prompt` and `datetime_aware` are all required by PersonaUpsertRequest
   * (server/features/persona/models.py:159). The removed `num_chunks`,
   * `llm_model_*_override` and `recency_bias` fields have no replacement here —
   * model selection is `default_model_configuration_id` only.
   */
  createPersona(args: {
    name: string;
    description: string;
    system_prompt: string;
    task_prompt: string;
    datetime_aware: boolean;
    replace_base_system_prompt: boolean;
    tool_ids: number[];
    document_set_ids: number[];
  }): Promise<PersonaSnapshot> {
    return this.request<PersonaSnapshot>('POST', '/persona', {
      ...args,
      is_public: true,
      users: [],
      groups: [],
      label_ids: [],
      is_featured: false,
    });
  }

  listIngestedDocs(): Promise<DocMinimalInfo[]> {
    return this.request<DocMinimalInfo[]>('GET', '/onyx-api/ingestion');
  }

  /** Response is grouped by source; flatten `[].indexing_statuses`. */
  async getIndexingStatuses(): Promise<IndexingStatus[]> {
    const groups = await this.request<{ indexing_statuses?: IndexingStatus[] }[]>(
      'POST',
      '/manage/admin/connector/indexing-status',
      { get_all_connectors: true },
    );
    return groups.flatMap((g) => g.indexing_statuses ?? []);
  }

  async listConnectorStatuses(): Promise<unknown[]> {
    return this.request<unknown[]>('GET', '/manage/admin/connector/status');
  }

  /** Stores one file for a file connector. `unzip=false` so a stray zip stays one file. */
  uploadConnectorFile(name: string, bytes: Buffer, contentType: string): Promise<FileUploadResponse> {
    const form = new FormData();
    form.append('files', new Blob([bytes], { type: contentType }), name);
    return this.postForm<FileUploadResponse>('/manage/admin/connector/file/upload?unzip=false', form);
  }

  /**
   * Uploads a zip with unzip=true. Onyx keeps a `.onyx_metadata.json` inside it as the
   * connector's zip_metadata_file_id and skips dot-files, so a zip holding only the metadata
   * file yields the metadata id and no documents.
   */
  uploadConnectorZip(name: string, bytes: Buffer): Promise<FileUploadResponse> {
    const form = new FormData();
    form.append('files', new Blob([bytes], { type: 'application/zip' }), name);
    return this.postForm<FileUploadResponse>('/manage/admin/connector/file/upload?unzip=true', form);
  }

  /** Creates the Connector row only; indexing starts when a credential is linked. */
  createFileConnector(name: string, files: FileUploadResponse): Promise<{ id: number }> {
    return this.request<{ id: number }>('POST', '/manage/admin/connector', {
      name,
      source: 'file',
      input_type: 'load_state',
      connector_specific_config: {
        file_locations: files.file_paths,
        file_names: files.file_names,
        zip_metadata_file_id: files.zip_metadata_file_id,
      },
      refresh_freq: null,
      prune_freq: null,
      indexing_start: null,
      access_type: 'public',
      groups: [],
    });
  }

  /**
   * A file connector has nothing to authenticate, but a cc_pair needs a credential.
   * The admin UI creates this same empty one (web/.../pages/utils/files.ts:57).
   */
  createFileCredential(name: string): Promise<{ id: number }> {
    return this.request<{ id: number }>('POST', '/manage/credential', {
      credential_json: {},
      admin_public: true,
      curator_public: true,
      source: 'file',
      groups: [],
      name,
    });
  }

  /** Creates the cc_pair and queues indexing. Returns the cc_pair id. */
  async linkCredential(connectorId: number, credentialId: number, name: string): Promise<number> {
    const res = await this.request<{ data: number }>(
      'PUT',
      `/manage/connector/${connectorId}/credential/${credentialId}`,
      { name, access_type: 'public', groups: [] },
    );
    return res.data;
  }

  getCcPair(ccPairId: number): Promise<CcPairInfo> {
    return this.request<CcPairInfo>('GET', `/manage/admin/cc-pair/${ccPairId}`);
  }

  /** Newest first. */
  async listIndexAttempts(ccPairId: number, pageSize = 1): Promise<IndexAttempt[]> {
    const res = await this.request<{ items: IndexAttempt[] }>(
      'GET',
      `/manage/admin/cc-pair/${ccPairId}/index-attempts?page_num=0&page_size=${pageSize}`,
    );
    return res.items;
  }

  runConnectorOnce(connectorId: number, credentialId: number, fromBeginning: boolean): Promise<unknown> {
    return this.request('POST', '/manage/admin/connector/run-once', {
      connector_id: connectorId,
      credential_ids: [credentialId],
      from_beginning: fromBeginning,
    });
  }

  setCcPairStatus(ccPairId: number, status: 'ACTIVE' | 'PAUSED'): Promise<unknown> {
    return this.request('PUT', `/manage/admin/cc-pair/${ccPairId}/status`, { status });
  }

  /** Marks the cc_pair DELETING; a background task removes its documents and files. */
  deleteCcPair(connectorId: number, credentialId: number): Promise<unknown> {
    return this.request('POST', '/manage/admin/deletion-attempt', {
      connector_id: connectorId,
      credential_id: credentialId,
    }, { raw: true });
  }

  getWorkspaceSettings(): Promise<WorkspaceSettings> {
    return this.request<WorkspaceSettings>('GET', '/settings');
  }

  /** Partial update: Onyx merges only the fields sent (server/settings/api.py). */
  patchWorkspaceSettings(patch: Partial<WorkspaceSettings>): Promise<WorkspaceSettings> {
    return this.request<WorkspaceSettings>('PATCH', '/admin/settings', patch);
  }

  getSearchSettings(): Promise<SearchSettings> {
    return this.request<SearchSettings>('GET', '/search-settings/get-current-search-settings');
  }

  async listLlmProviders(): Promise<LlmProvider[]> {
    const res = await this.request<{ providers: LlmProvider[] }>('GET', '/admin/llm/provider');
    return res.providers;
  }

  /**
   * One self-contained call per eval case. Omitting `chat_session_id` and passing
   * `chat_session_info` makes the validator (query_and_chat/models.py:156) create a
   * fresh session, so cases never share history. Passing both is a 422.
   *
   * `stream: false` returns a single ChatFullResponse instead of NDJSON.
   */
  sendMessage(opts: SendMessageOptions): Promise<ChatFullResponse> {
    return this.request<ChatFullResponse>('POST', '/chat/send-chat-message', {
      message: opts.message,
      chat_session_info: { persona_id: opts.personaId },
      ...(opts.documentSets
        ? { internal_search_filters: { document_set: opts.documentSets } }
        : {}),
      // model_configuration_id is mandatory. A model_version without it silently runs
      // the workspace default and still returns 200 (llm/factory.py:176-191).
      ...(opts.modelConfigurationId
        ? {
            llm_override: {
              model_configuration_id: opts.modelConfigurationId,
              temperature: opts.temperature ?? 0,
            },
          }
        : {}),
      ...(opts.allowedToolIds ? { allowed_tool_ids: opts.allowedToolIds } : {}),
      stream: false,
      include_citations: true,
    });
  }

  deleteChatSession(id: string): Promise<unknown> {
    return this.request('DELETE', `/chat/delete-chat-session/${id}`, undefined, {
      raw: true,
    });
  }
}

/** Poll `fn` until `done`, or throw after `timeoutMs`. */
export async function pollUntil<T>(
  fn: () => Promise<T>,
  done: (value: T) => boolean,
  { intervalMs, timeoutMs, label }: { intervalMs: number; timeoutMs: number; label: string },
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T = await fn();
  while (!done(last)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await fn();
  }
  return last;
}
