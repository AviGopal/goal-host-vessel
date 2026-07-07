export interface FsListParams {
  path: string;
  glob?: string;
  shuffle?: boolean;
}

export interface JsonPathExtractParams {
  input: string;
  path: string;
}

export interface FsReadParams {
  path: string;
}

export interface LlmCompletionDispatchParams {
  input: string;
  requiredFields: string[];
  systemPrompt?: string;
}

export interface HttpFetchParams {
  url: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export type TaskParams =
  | ({ type: "fs_list" } & { params: FsListParams })
  | ({ type: "json_path_extract" } & { params: JsonPathExtractParams })
  | ({ type: "fs_read" } & { params: FsReadParams })
  | ({ type: "llm_completion_dispatch" } & { params: LlmCompletionDispatchParams })
  | ({ type: "http_fetch" } & { params: HttpFetchParams });

export interface GoalTask extends Record<string, unknown> {
  id: string;
  type: string;
  params: Record<string, unknown>;
}

export interface GoalCompose {
  name: string;
  tags: string[];
  outputShape: string;
  tasks: GoalTask[];
}
