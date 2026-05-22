import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

const codexBaseUrl = "https://chatgpt.com/backend-api/codex/responses";
const codexClientId = "app_EMoamEEZ73f0CkXaXp7hrann";
const codexTokenUrl = "https://auth.openai.com/oauth/token";
const accountIdClaim = "https://api.openai.com/auth";

const { values } = parseArgs({
  options: {
    cached: { type: "boolean" },
    "context-size": { type: "string" },
    format: { type: "string" },
    model: { type: "string" },
    query: { type: "string", short: "q" },
  },
});

const apiKey = process.env.OPENAI_API_KEY?.trim();
const query = values.query?.trim();
const model = values.model?.trim() || process.env.OPENAI_WEB_SEARCH_MODEL?.trim() || "gpt-5.5";
const format = values.format?.trim() || "json";
const contextSize = values["context-size"]?.trim();

if (!query) {
  throw new Error("--query is required.");
}
if (format !== "json" && format !== "text") {
  throw new Error("--format must be json or text.");
}
if (contextSize && !["low", "medium", "high"].includes(contextSize)) {
  throw new Error("--context-size must be low, medium, or high.");
}

const result = apiKey ? await runOpenAIWebSearch(apiKey) : await runCodexWebSearch();

if (format === "text") {
  process.stdout.write(result.text);
  if (result.sources.length > 0) {
    process.stdout.write("\n\nSources:\n");
    for (const source of result.sources) {
      process.stdout.write(`- ${source.title ? `${source.title}: ` : ""}${source.url}\n`);
    }
  } else {
    process.stdout.write("\n");
  }
} else {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function runOpenAIWebSearch(key: string) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    body: JSON.stringify({
      input: query,
      model,
      store: false,
      tools: [webSearchTool()],
    }),
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    method: "POST",
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`OpenAI web search request failed with ${response.status}: ${body}`);
  }

  return searchResultFromResponse(JSON.parse(body));
}

async function runCodexWebSearch() {
  const auth = await loadCodexAuth();
  const response = await fetch(codexBaseUrl, {
    body: JSON.stringify({
      input: [{ content: [{ text: query, type: "input_text" }], role: "user" }],
      instructions: "Search the web and answer with concise, source-backed information.",
      model,
      store: false,
      stream: true,
      tools: [webSearchTool()],
    }),
    headers: {
      accept: "text/event-stream",
      authorization: `Bearer ${auth.access}`,
      "chatgpt-account-id": auth.accountId,
      "content-type": "application/json",
      "openai-beta": "responses=experimental",
      originator: "pi",
      "user-agent": "pi web search skill",
    },
    method: "POST",
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Codex web search request failed with ${response.status}: ${body}`);
  }

  return searchResultFromEvents(parseServerSentEvents(body));
}

function webSearchTool() {
  return stripUndefined({
    external_web_access: values.cached ? false : undefined,
    search_context_size: contextSize,
    type: "web_search",
  });
}

function searchResultFromResponse(response: unknown) {
  const text = textFromResponse(response);
  const sources = uniqueSources(findSources(response));
  if (!text) {
    throw new Error("OpenAI web search response did not include output text.");
  }
  return { sources, text };
}

function searchResultFromEvents(events: unknown[]) {
  const deltas = events
    .map((event) => (isRecord(event) && event.type === "response.output_text.delta" ? event.delta : undefined))
    .filter((delta): delta is string => typeof delta === "string");

  const text = deltas.join("") || textFromResponse(events);
  const sources = uniqueSources(findSources(events));
  if (!text) {
    throw new Error("Codex web search response did not include output text.");
  }
  return { sources, text };
}

function textFromResponse(value: unknown): string {
  if (!isRecord(value)) {
    return "";
  }

  if (typeof value.output_text === "string") {
    return value.output_text;
  }

  if (Array.isArray(value.output)) {
    return value.output
      .flatMap((item) => (isRecord(item) && Array.isArray(item.content) ? item.content : []))
      .map((content) => (isRecord(content) && typeof content.text === "string" ? content.text : ""))
      .join("");
  }

  if (Array.isArray(value)) {
    return value.map(textFromResponse).join("");
  }

  return Object.values(value).map(textFromResponse).join("");
}

function findSources(value: unknown): Array<{ title?: string; url: string }> {
  if (!isRecord(value)) {
    if (Array.isArray(value)) {
      return value.flatMap(findSources);
    }
    return [];
  }

  const current =
    value.type === "url_citation" && typeof value.url === "string"
      ? [
          {
            title: typeof value.title === "string" ? value.title : undefined,
            url: value.url,
          },
        ]
      : [];

  return [...current, ...Object.values(value).flatMap(findSources)];
}

function uniqueSources(sources: Array<{ title?: string; url: string }>) {
  const seen = new Set<string>();
  return sources.filter((source) => {
    if (seen.has(source.url)) {
      return false;
    }
    seen.add(source.url);
    return true;
  });
}

function parseServerSentEvents(body: string) {
  const events: unknown[] = [];
  for (const chunk of body.split(/\n\n+/)) {
    const data = chunk
      .split(/\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") {
      continue;
    }
    events.push(JSON.parse(data));
  }
  return events;
}

async function loadCodexAuth() {
  const authPath = join(process.env.PI_CODING_AGENT_DIR?.trim() || join(process.env.HOME ?? "", ".codex"), "auth.json");
  return await withAuthLock(authPath, async () => {
    const auth = JSON.parse(await readFile(authPath, "utf8")) as Record<string, unknown>;
    const credential = readStoredCodexCredential(auth);
    if (!credential) {
      throw new Error("OPENAI_API_KEY or Codex auth in PI_CODING_AGENT_DIR/auth.json is required.");
    }

    if (Date.now() < credential.expires - 60_000) {
      return credential;
    }

    const refreshed = await refreshCodexCredential(credential.refresh);
    auth["openai-codex"] = {
      type: "oauth",
      access: refreshed.access,
      refresh: refreshed.refresh,
      expires: refreshed.expires,
      accountId: refreshed.accountId,
    };
    if (typeof auth.tokens === "object" && auth.tokens !== null) {
      Object.assign(auth.tokens as Record<string, unknown>, {
        access_token: refreshed.access,
        account_id: refreshed.accountId,
        refresh_token: refreshed.refresh,
      });
    }
    await writeFile(authPath, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
    return refreshed;
  });
}

async function withAuthLock<T>(authPath: string, fn: () => Promise<T>) {
  const lockPath = `${authPath}.lock`;
  const startedAt = Date.now();
  while (true) {
    try {
      await mkdir(lockPath);
      break;
    } catch {
      if (Date.now() - startedAt > 30_000) {
        throw new Error(`Timed out waiting for auth lock: ${lockPath}`);
      }
      try {
        const lock = await stat(lockPath);
        if (Date.now() - lock.mtimeMs > 60_000) {
          await rm(lockPath, { force: true, recursive: true });
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  try {
    return await fn();
  } finally {
    await rm(lockPath, { force: true, recursive: true });
  }
}

function readStoredCodexCredential(auth: Record<string, unknown>) {
  const piCredential = auth["openai-codex"];
  if (isRecord(piCredential) && typeof piCredential.access === "string" && typeof piCredential.refresh === "string") {
    return {
      access: piCredential.access,
      accountId: typeof piCredential.accountId === "string" ? piCredential.accountId : accountIdFromToken(piCredential.access),
      expires: typeof piCredential.expires === "number" ? piCredential.expires : expiresFromToken(piCredential.access),
      refresh: piCredential.refresh,
    };
  }

  const tokens = auth.tokens;
  if (isRecord(tokens) && typeof tokens.access_token === "string" && typeof tokens.refresh_token === "string") {
    return {
      access: tokens.access_token,
      accountId: typeof tokens.account_id === "string" ? tokens.account_id : accountIdFromToken(tokens.access_token),
      expires: expiresFromToken(tokens.access_token),
      refresh: tokens.refresh_token,
    };
  }

  return undefined;
}

async function refreshCodexCredential(refreshToken: string) {
  const response = await fetch(codexTokenUrl, {
    body: new URLSearchParams({
      client_id: codexClientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Codex token refresh failed with ${response.status}: ${body}`);
  }

  const data = JSON.parse(body) as { access_token?: string; expires_in?: number; refresh_token?: string };
  if (!data.access_token || !data.refresh_token || typeof data.expires_in !== "number") {
    throw new Error(`Codex token refresh returned an invalid response: ${body}`);
  }

  return {
    access: data.access_token,
    accountId: accountIdFromToken(data.access_token),
    expires: Date.now() + data.expires_in * 1000,
    refresh: data.refresh_token,
  };
}

function accountIdFromToken(token: string) {
  const accountId = decodeJwtPayload(token)[accountIdClaim]?.chatgpt_account_id;
  if (typeof accountId !== "string") {
    throw new Error("Codex access token does not include a ChatGPT account id.");
  }
  return accountId;
}

function expiresFromToken(token: string) {
  const exp = decodeJwtPayload(token).exp;
  if (typeof exp !== "number") {
    throw new Error("Codex access token does not include an expiration timestamp.");
  }
  return exp * 1000;
}

function decodeJwtPayload(token: string) {
  const payload = token.split(".")[1];
  if (!payload) {
    throw new Error("Invalid JWT token.");
  }
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, any>;
}

function stripUndefined(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}
