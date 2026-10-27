/**
 * Minimal Trello REST API client.
 *
 * - Authenticates with an API key + token sent in the `Authorization` header
 *   (keeps secrets out of URLs and logs).
 * - Throttles requests client-side to stay under Trello's per-token limit
 *   (100 requests / 10 s).
 * - Retries 429 and 5xx responses with exponential backoff.
 */

export type QueryValue = string | number | boolean | undefined | null | string[];
export type Query = Record<string, QueryValue>;

export interface TrelloClientOptions {
  apiKey: string;
  token: string;
  baseUrl?: string;
  /** Max requests per window. Defaults to 90 (Trello allows 100 per token). */
  maxRequestsPerWindow?: number;
  windowMs?: number;
  maxRetries?: number;
  /** Base delay for exponential backoff, in ms. */
  retryBaseDelayMs?: number;
  fetchImpl?: typeof fetch;
}

export class TrelloApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly method: string,
    public readonly path: string,
    public readonly body: string,
  ) {
    super(`Trello API ${method} ${path} failed with ${status}: ${body.slice(0, 500)}`);
    this.name = "TrelloApiError";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class TrelloClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly timestamps: number[] = [];

  constructor(options: TrelloClientOptions) {
    if (!options.apiKey || !options.token) {
      throw new Error("Trello API key and token are required");
    }
    this.baseUrl = (options.baseUrl ?? "https://api.trello.com/1").replace(/\/$/, "");
    this.authHeader = `OAuth oauth_consumer_key="${options.apiKey}", oauth_token="${options.token}"`;
    this.maxRequests = options.maxRequestsPerWindow ?? 90;
    this.windowMs = options.windowMs ?? 10_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 1_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get<T = unknown>(path: string, query?: Query) {
    return this.request<T>("GET", path, query);
  }
  post<T = unknown>(path: string, query?: Query) {
    return this.request<T>("POST", path, query);
  }
  put<T = unknown>(path: string, query?: Query) {
    return this.request<T>("PUT", path, query);
  }
  delete<T = unknown>(path: string, query?: Query) {
    return this.request<T>("DELETE", path, query);
  }

  /** Trello accepts parameters for every method in the query string. */
  buildUrl(path: string, query: Query = {}): string {
    const url = new URL(this.baseUrl + (path.startsWith("/") ? path : `/${path}`));
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, Array.isArray(value) ? value.join(",") : String(value));
    }
    return url.toString();
  }

  async request<T>(method: string, path: string, query?: Query): Promise<T> {
    const url = this.buildUrl(path, query);

    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      const response = await this.fetchImpl(url, {
        method,
        headers: { Authorization: this.authHeader, Accept: "application/json" },
      });

      if (response.ok) {
        const text = await response.text();
        return (text ? JSON.parse(text) : null) as T;
      }

      const body = await response.text();
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= this.maxRetries) {
        throw new TrelloApiError(response.status, method, path, body);
      }
      await sleep(this.retryDelay(response, attempt));
    }
  }

  private retryDelay(response: Response, attempt: number): number {
    const retryAfter = Number(response.headers.get("retry-after"));
    if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
    return this.retryBaseDelayMs * 2 ** attempt;
  }

  /** Sliding-window limiter: waits until a request slot is free. */
  private async throttle(): Promise<void> {
    for (;;) {
      const now = Date.now();
      while (this.timestamps.length && now - this.timestamps[0] >= this.windowMs) {
        this.timestamps.shift();
      }
      if (this.timestamps.length < this.maxRequests) {
        this.timestamps.push(now);
        return;
      }
      await sleep(this.windowMs - (now - this.timestamps[0]) + 5);
    }
  }
}
