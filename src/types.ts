/**
 * Wire types for the Onyx routes this suite uses.
 *
 * Sourced from the Onyx backend at commit 06aa2b09cc. Field names are load-bearing;
 * see the file references on each type before changing one.
 */

/** `SearchDoc` — backend/onyx/context/search/models.py:305 */
export interface SearchDoc {
  document_id: string;
  chunk_ind: number;
  /** Stable across re-seeds. `document_id` is not: file connectors mint a new UUID. */
  semantic_identifier: string;
  link: string | null;
  blurb: string;
  source_type: string;
  score: number | null;
  is_relevant: boolean | null;
  match_highlights: string[];
  metadata: Record<string, string | string[]>;
}

/** `ToolCallResponse` — backend/onyx/chat/models.py:56 */
export interface ToolCallResponse {
  /** The tool's `NAME` constant, e.g. `internal_search` — NOT the `SearchTool` in_code id. */
  tool_name: string;
  tool_arguments: Record<string, unknown>;
  tool_result: string;
  search_docs: SearchDoc[] | null;
}

/** `CitationInfo` — backend/onyx/server/query_and_chat/streaming_models.py:141 */
export interface CitationInfo {
  type: 'citation_info';
  citation_number: number;
  document_id: string;
}

/** `ChatFullResponse` — backend/onyx/chat/models.py:80. Returned when `stream: false`. */
export interface ChatFullResponse {
  answer: string;
  answer_citationless: string;
  pre_answer_reasoning: string | null;
  tool_calls: ToolCallResponse[];
  /**
   * Only populated from `AgentResponseStart.final_documents`
   * (process_message.py:2215), so this can be `[]` even when search ran.
   * Always union it with `tool_calls[].search_docs`.
   */
  top_documents: SearchDoc[];
  citation_info: CitationInfo[];
  message_id: number;
  /** Joins to the Langfuse `session_id` facet. This is the telemetry key. */
  chat_session_id: string | null;
  incognito: boolean;
  error_msg: string | null;
}

/** `UserPersonalization` — backend/onyx/server/manage/models.py:134 */
export interface UserPersonalization {
  name: string | null;
  role: string | null;
  use_memories: boolean;
  enable_memory_tool: boolean;
  memories?: unknown[];
  user_preferences?: string | null;
}

export interface MeResponse {
  id: string;
  email: string;
  role: string;
  effective_permissions: string[];
  personalization: UserPersonalization | null;
}

/** `ToolSnapshot` — backend/onyx/server/features/tool/models.py:27 */
export interface ToolSnapshot {
  id: number;
  name: string;
  display_name: string | null;
  /** MemoryTool is never present: tool_visibility.py:38 sets expose_to_frontend=False. */
  in_code_tool_id: string | null;
}

/** `DocumentSetSummary` — backend/onyx/server/features/document_set/models.py:139 */
export interface DocumentSetSummary {
  id: number;
  name: string;
  description: string | null;
  cc_pair_summaries: { id: number }[];
  /** Vespa sync flag. Poll until true before evaluating. */
  is_up_to_date: boolean;
  is_public: boolean;
}

export interface PersonaSnapshot {
  id: number;
  name: string;
  description: string;
  is_public: boolean;
  tools: { id: number; in_code_tool_id?: string | null }[];
  document_sets: { id: number }[];
}

/** `DocMinimalInfo` — backend/onyx/server/onyx_api/ingestion.py */
export interface DocMinimalInfo {
  document_id: string;
  semantic_id: string;
  link: string | null;
}

export interface IndexingStatus {
  cc_pair_id: number;
  name: string | null;
  in_progress: boolean;
  last_success: string | null;
  docs_indexed: number;
}

/** `FileUploadResponse` — server/documents/connector.py:299 */
export interface FileUploadResponse {
  file_paths: string[];
  file_names: string[];
  zip_metadata_file_id: string | null;
}

/** The subset of `CCPairFullInfo` (server/documents/models.py:440) this suite reads. */
export interface CcPairInfo {
  id: number;
  name: string;
  status: string;
  num_docs_indexed: number;
  indexing: boolean;
  connector: { id: number };
  credential: { id: number };
}

/** `IndexAttemptSnapshot` — server/documents/models.py:182. Status values are lowercase. */
export interface IndexAttempt {
  id: number;
  status: string | null;
  from_beginning: boolean;
  total_docs_indexed: number;
  error_msg: string | null;
  error_count: number;
  /** ISO 8601 with offset, e.g. `2026-09-08T00:46:51.057926+00:00`. */
  time_started: string | null;
}

/** `SavedSearchSettings` — the fields this suite pins. */
export interface SearchSettings {
  model_name: string;
  multipass_indexing: boolean;
  enable_contextual_rag: boolean;
  contextual_rag_model_configuration_id: number | null;
}

/** `Settings` — server/settings/models.py. Only the fields this suite pins. */
export interface WorkspaceSettings {
  image_extraction_and_analysis_enabled: boolean | null;
  /** Lets the chat flow infer time and source filters from the question. Unset means on. */
  auto_detect_search_filters: boolean | null;
}

/** `LLMProviderView` — server/manage/llm/models.py:168 */
export interface LlmProvider {
  id: number;
  name: string | null;
  provider: string;
  model_configurations: { id: number | null; name: string; max_input_tokens: number | null }[];
}

export interface CorpusRef {
  /** Relative to the repo root. */
  manifest: string;
  /** Selects files from the corpus manifest; also the Onyx document set name. */
  doc_set: string;
  document_set_description: string;
}

export interface Manifest {
  onyx_commit: string;
  search_settings: {
    id: number;
    model_name: string;
    multipass_indexing: boolean;
    enable_contextual_rag: boolean;
    contextual_rag_model_configuration_id: number | null;
    contextual_rag_model_name: string | null;
    contextual_rag_max_input_tokens: number | null;
  };
  /** Environment of the Onyx background worker; `npm run seed` reads it through docker. */
  onyx_background_env: Record<string, string>;
  /**
   * Environment of the Onyx api_server; every run reads it through docker
   * (ONYX_API_SERVER_CONTAINER) and stops on drift. Keys starting with `$` are comments.
   */
  onyx_api_server_env?: Record<string, string>;
  /**
   * In-container patches the api_server must carry for a run to measure what the manifest
   * says. Each is checked with `<apply> check` before a run (onyx-patches/<name>/apply.sh).
   */
  onyx_api_server_patches?: { name: string; apply: string; why: string }[];
  /** Workspace settings that change what indexing stores. */
  workspace_settings: {
    image_extraction_and_analysis_enabled: boolean;
  };
  max_chunks_fed_to_chat: number;
  /** The provider every eval model must belong to. Anthropic is never called directly. */
  llm_provider_name: string;
  /**
   * The model axis. One entry per model under test; `label` is the second half of a
   * provider label (`<promptVariant>:<modelLabel>`) and is how bindProviders resolves
   * which configuration a provider sends.
   *
   * `llm_override_covers_cascade` is per model on purpose: one override covering query
   * expansion, the time filter and relevance classification was verified for one model on
   * one day, and a provider that fans out differently for another model would mislabel the
   * axis silently. `null` means unverified.
   */
  models: {
    label: string;
    model_configuration_id: number;
    model_name: string;
    /**
     * The Onyx provider that must own this configuration, by name, or by provider type for an
     * unnamed provider (the local Ollama one is `ollama_chat`). Defaults to llm_provider_name.
     */
    provider?: string;
    llm_override_covers_cascade: boolean | null;
    llm_override_verified_at: string | null;
    note?: string;
  }[];
  /** The corpus a run queries. */
  corpus: CorpusRef;
  /** Further corpora `npm run seed -- --corpus <doc_set>` can index. A run never reads them. */
  extra_corpora?: CorpusRef[];
  personas: {
    variant: string;
    name: string;
    description: string;
    system_prompt: string;
    task_prompt: string;
    replace_base_system_prompt: boolean;
    datetime_aware: boolean;
    /** false: no search tool (the passage-oracle persona, which answers from the message). */
    search_tool?: boolean;
  }[];
}

/** Written by the setup hook for the asserts and the telemetry join to read. */
export interface RunContext {
  runId: string;
  startedAt: string;
  baseUrl: string;
  documentSetName: string;
  /**
   * The perfect-filter arm (promptfooconfig.rentals-asof.yaml): the per-date document sets its
   * tests search through vars.as_of_doc_set, each verified like the run's own set.
   */
  asOfDocSets?: string[];
  searchToolId: number;
  /** variant name -> persona id */
  personaIds: Record<string, number>;
  /** Whether Onyx inferred search filters from the question during this run. */
  autoDetectSearchFilters: boolean;
  /** The llm-rubric judge, set by the beforeAll hook once the family check passes. */
  judgeModel?: string;
  manifest: Manifest;
}
