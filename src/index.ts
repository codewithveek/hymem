/** Public library API — `import { remember, ask } from "hymem"` */
export { ingestSession, ingestHistory } from "./ingest.js";
export { recall } from "./retrieve.js";
export { answer, ABSTAIN_ANSWER } from "./answer.js";
export { extractFacts, factId, canonEntity } from "./extract.js";
export { cypher, cypherHttp, closeHydra, nodeId, int, upsertNodes, mergeEdges, deleteAll } from "./hydra.js";
export { factNodeId, entityNodeId, sessionNodeId } from "./ids.js";
export { config } from "./config.js";
export type { SessionInput, Fact, RetrievedFact, RecallResult } from "./types.js";
