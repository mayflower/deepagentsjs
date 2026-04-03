/**
 * HTTP transport layer for communicating with the sandbox-router.
 *
 * All requests are annotated with the sandbox routing headers
 * (`X-Sandbox-ID`, `X-Sandbox-Namespace`, `X-Sandbox-Port`) so the
 * router can proxy them to the correct sandbox pod.
 */

import type { ConnectionStrategy } from "./connection.js";
import { K8sAgentSandboxError } from "./types.js";

// ---------------------------------------------------------------------------
// Response types (match the sandbox runtime's JSON shapes)
// ---------------------------------------------------------------------------

export interface ExecuteResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// ---------------------------------------------------------------------------
// SandboxRouterClient
// ---------------------------------------------------------------------------

export class SandboxRouterClient {
  readonly #strategy: ConnectionStrategy;
  readonly #sandboxId: string;
  readonly #namespace: string;
  readonly #serverPort: number;

  constructor(
    strategy: ConnectionStrategy,
    sandboxId: string,
    namespace: string,
    serverPort: number = 8888,
  ) {
    this.#strategy = strategy;
    this.#sandboxId = sandboxId;
    this.#namespace = namespace;
    this.#serverPort = serverPort;
  }

  async #request(
    method: string,
    endpoint: string,
    options?: {
      body?: BodyInit;
      headers?: Record<string, string>;
      signal?: AbortSignal;
    },
  ): Promise<Response> {
    await this.#strategy.verifyConnection();
    const baseUrl = await this.#strategy.connect();
    const url = `${baseUrl}/${endpoint}`;

    const headers: Record<string, string> = {
      "X-Sandbox-ID": this.#sandboxId,
      "X-Sandbox-Namespace": this.#namespace,
      "X-Sandbox-Port": String(this.#serverPort),
      ...options?.headers,
    };

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: options?.body,
        signal: options?.signal,
      });
    } catch (err) {
      throw new K8sAgentSandboxError(
        `Failed to connect to sandbox-router at ${url}: ${err instanceof Error ? err.message : String(err)}`,
        "CONNECTION_FAILED",
        err instanceof Error ? err : undefined,
      );
    }

    return response;
  }

  /**
   * Execute a shell command in the sandbox.
   */
  async execute(command: string, signal?: AbortSignal): Promise<ExecuteResult> {
    const response = await this.#request("POST", "execute", {
      body: JSON.stringify({ command }),
      headers: { "Content-Type": "application/json" },
      signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "(unreadable body)");
      throw new K8sAgentSandboxError(
        `Execute request failed (HTTP ${response.status}): ${text}`,
        "HTTP_ERROR",
      );
    }

    // Read body as text first, then parse — avoids the consumed-body
    // problem if JSON.parse fails (e.g., proxy returning HTML).
    const text = await response.text();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch (parseErr) {
      throw new K8sAgentSandboxError(
        `Execute response was not valid JSON (HTTP ${response.status}): ${text.slice(0, 200)}`,
        "HTTP_ERROR",
        parseErr instanceof Error ? parseErr : undefined,
      );
    }

    return {
      stdout: typeof body.stdout === "string" ? body.stdout : "",
      stderr: typeof body.stderr === "string" ? body.stderr : "",
      exitCode: typeof body.exit_code === "number" ? body.exit_code : -1,
    };
  }

  /**
   * Download a file from the sandbox.
   *
   * The `relativePath` is relative to the sandbox working directory
   * (`/app`), e.g. `src/main.py`.
   */
  async download(relativePath: string): Promise<Uint8Array> {
    const encoded = encodeURIComponent(relativePath);
    const response = await this.#request("GET", `download/${encoded}`);

    if (response.status === 404) {
      throw new K8sAgentSandboxError(
        `File not found: ${relativePath}`,
        "FILE_OPERATION_FAILED",
      );
    }
    if (response.status === 403) {
      throw new K8sAgentSandboxError(
        `Access denied: ${relativePath}`,
        "FILE_OPERATION_FAILED",
      );
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "(unreadable body)");
      throw new K8sAgentSandboxError(
        `Download failed (HTTP ${response.status}): ${text}`,
        "HTTP_ERROR",
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    return new Uint8Array(arrayBuffer);
  }

  /**
   * Health check. Returns true on 200, false on any error.
   */
  async healthz(): Promise<boolean> {
    try {
      return await this.healthCheck();
    } catch {
      return false;
    }
  }

  /**
   * Health check that throws on connection failure (used by
   * `initialize()` for diagnostic error messages).
   */
  async healthCheck(): Promise<boolean> {
    const response = await this.#request("GET", "");
    return response.ok;
  }

  async close(): Promise<void> {
    await this.#strategy.close();
  }
}
