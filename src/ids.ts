/**
 * Graph-id derivation. HydraDB node ids are non-negative integers, so every
 * human-readable key (fact hash, entity name, session id) is mapped through a
 * stable 52-bit hash; the key itself is stored on the node as `key`/`name`.
 */
import type { Integer } from "neo4j-driver";
import { nodeId } from "./hydra.js";

export const factNodeId = (factId: string): Integer => nodeId(`fact:${factId}`);
export const entityNodeId = (name: string): Integer => nodeId(`entity:${name}`);
export const sessionNodeId = (sessionId: string): Integer => nodeId(`session:${sessionId}`);
