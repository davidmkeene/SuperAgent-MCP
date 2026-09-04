/**
 * Simple TTL cache for agent invocation results.
 * Keyed by hash of (provider + model + prompt).
 * Prevents duplicate work when the same prompt is sent to the same provider.
 */

import { createHash } from "node:crypto";
import { AgentInvocationResult } from "./types.js";

interface CacheEntry {
  result: AgentInvocationResult;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_SIZE = 100;

export function cacheKey(provider: string, prompt: string, model?: string): string {
  const raw = `${provider}:${model || "default"}:${prompt}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

export function getCached(key: string): AgentInvocationResult | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return entry.result;
}

export function setCache(key: string, result: AgentInvocationResult, ttlMs: number = DEFAULT_TTL_MS): void {
  // Evict oldest entries if cache is full
  if (cache.size >= MAX_CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { result, expiresAt: Date.now() + ttlMs });
}

export function clearCache(): void {
  cache.clear();
}

export function cacheStats(): { size: number; maxSize: number } {
  return { size: cache.size, maxSize: MAX_CACHE_SIZE };
}
