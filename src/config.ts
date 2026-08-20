export const config = {
  // --- HydraDB node (see scripts/run-hydra.sh and the repo README) ---
  boltUrl: process.env.HYDRA_BOLT_URL ?? "neo4j://127.0.0.1:7687",
  httpUrl: process.env.HYDRA_HTTP_URL ?? "http://127.0.0.1:8443",
  namespace: process.env.HYDRA_NAMESPACE ?? "default",
  graphId: process.env.HYDRA_GRAPH_ID ?? "default",
  cellId: process.env.HYDRA_CELL_ID ?? "cell-0",
  token: process.env.HYDRA_TOKEN ?? "local-development-token-32-bytes",

  // --- LLM (any OpenAI-compatible chat/completions endpoint) ---
  llmBaseUrl: process.env.LLM_BASE_URL ?? "https://api.openai.com/v1",
  llmApiKey: process.env.LLM_API_KEY ?? "",
  llmModel: process.env.LLM_MODEL ?? "gpt-4o-mini",

  // --- Memory behaviour ---
  /** Facts returned per question before synthesis. */
  maxFacts: Number(process.env.MEM_MAX_FACTS ?? 24),
  /** Below this many supporting facts, abstain instead of answering. */
  abstainThreshold: Number(process.env.MEM_ABSTAIN_THRESHOLD ?? 1),
};
