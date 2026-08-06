/**
 * Code Space — fetch wrappers over the code_space_routes.py CONTRACT (see the
 * module doc in codespaceTypes.ts). Errors classify through the SAME
 * ghlib.ts error ladder the rest of the GitHub-backed surfaces use, so the
 * rail can reuse the existing degrade components as-is.
 *
 *   POST /api/containers/{cid}/code/threads
 *   GET  /api/containers/{cid}/code/threads?ref=&path=&status=
 *   GET  /api/code/threads/{tid}
 *   POST /api/code/threads/{tid}/messages
 */
import { classifyError, type GhError } from "../github/ghlib";
import type {
  CodeThreadDetailPayload,
  CodeThreadListPayload,
  CreateThreadBody,
  CreateThreadResponse,
  PostMessageBody,
  PostMessageResponse,
} from "./codespaceTypes";

export type CsResult<T> = { ok: true; data: T } | { ok: false; error: GhError };

async function doFetch<T>(url: string, init?: RequestInit): Promise<CsResult<T>> {
  try {
    const r = await fetch(url, init);
    const body = await r.json().catch(() => null);
    if (!r.ok) return { ok: false, error: classifyError(r.status, body) };
    return { ok: true, data: body as T };
  } catch (e) {
    return { ok: false, error: { kind: "error", status: 0, detail: (e as Error).message } };
  }
}

function threadsPrefix(cid: string): string {
  return "/api/containers/" + encodeURIComponent(cid) + "/code/threads";
}

export function fetchThreads(
  cid: string,
  opts: { ref?: string; path?: string; status?: string } = {},
): Promise<CsResult<CodeThreadListPayload>> {
  const q = new URLSearchParams();
  if (opts.ref) q.set("ref", opts.ref);
  if (opts.path != null) q.set("path", opts.path);
  if (opts.status) q.set("status", opts.status);
  const qs = q.toString();
  return doFetch<CodeThreadListPayload>(threadsPrefix(cid) + (qs ? "?" + qs : ""));
}

export function createThread(cid: string, body: CreateThreadBody): Promise<CsResult<CreateThreadResponse>> {
  return doFetch<CreateThreadResponse>(threadsPrefix(cid), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function fetchThread(tid: string): Promise<CsResult<CodeThreadDetailPayload>> {
  return doFetch<CodeThreadDetailPayload>("/api/code/threads/" + encodeURIComponent(tid));
}

export function postThreadMessage(tid: string, body: PostMessageBody): Promise<CsResult<PostMessageResponse>> {
  return doFetch<PostMessageResponse>("/api/code/threads/" + encodeURIComponent(tid) + "/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
