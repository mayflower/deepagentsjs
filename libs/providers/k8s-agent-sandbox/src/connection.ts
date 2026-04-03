/**
 * Connection strategies for reaching the sandbox-router service.
 *
 * - Direct: user provides a known base URL
 * - Gateway: discover IP from a Kubernetes Gateway resource
 * - Tunnel: kubectl port-forward to sandbox-router-svc
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, createServer } from "node:net";
import type { K8sClient } from "./k8s-client.js";
import {
  K8sAgentSandboxError,
  type K8sConnectionConfig,
  type K8sDirectConnectionConfig,
  type K8sGatewayConnectionConfig,
  type K8sTunnelConnectionConfig,
} from "./types.js";

const ROUTER_SERVICE_NAME = "svc/sandbox-router-svc";

// ---------------------------------------------------------------------------
// ConnectionStrategy interface
// ---------------------------------------------------------------------------

export interface ConnectionStrategy {
  /** Establishes the connection and returns the base URL. */
  connect(): Promise<string>;
  /** Releases any resources (child processes, etc.). */
  close(): Promise<void>;
  /** Checks health; throws if the connection is dead. */
  verifyConnection(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Direct
// ---------------------------------------------------------------------------

export class DirectConnectionStrategy implements ConnectionStrategy {
  readonly #baseUrl: string;

  constructor(config: K8sDirectConnectionConfig) {
    this.#baseUrl = config.baseUrl.replace(/\/+$/, "");
  }

  async connect(): Promise<string> {
    return this.#baseUrl;
  }

  async close(): Promise<void> {}

  async verifyConnection(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

export class GatewayConnectionStrategy implements ConnectionStrategy {
  readonly #k8sClient: K8sClient;
  readonly #gatewayName: string;
  readonly #gatewayNamespace: string;
  readonly #timeout: number;
  #baseUrl: string | null = null;

  constructor(config: K8sGatewayConnectionConfig, k8sClient: K8sClient) {
    this.#k8sClient = k8sClient;
    this.#gatewayName = config.gatewayName;
    this.#gatewayNamespace = config.gatewayNamespace ?? "default";
    this.#timeout = config.gatewayReadyTimeout ?? 180;
  }

  async connect(): Promise<string> {
    if (this.#baseUrl) return this.#baseUrl;

    const ip = await this.#k8sClient.waitForGatewayIp(
      this.#gatewayName,
      this.#gatewayNamespace,
      this.#timeout,
    );
    this.#baseUrl = `http://${ip}`;
    return this.#baseUrl;
  }

  async close(): Promise<void> {
    this.#baseUrl = null;
  }

  async verifyConnection(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Tunnel (kubectl port-forward)
// ---------------------------------------------------------------------------

export class TunnelConnectionStrategy implements ConnectionStrategy {
  readonly #namespace: string;
  readonly #portForwardReadyTimeout: number;
  #process: ChildProcess | null = null;
  #baseUrl: string | null = null;
  #localPort: number | null = null;

  constructor(config: K8sTunnelConnectionConfig) {
    this.#namespace = config.namespace ?? "default";
    this.#portForwardReadyTimeout = config.portForwardReadyTimeout ?? 30;
  }

  async connect(): Promise<string> {
    // Re-use existing connection if still alive
    if (this.#baseUrl && this.#process && this.#process.exitCode === null) {
      return this.#baseUrl;
    }

    // Clean up any dead process
    if (this.#process) {
      await this.close();
    }

    // Find a free port
    this.#localPort = await this.#getFreePort();

    // Start kubectl port-forward
    this.#process = spawn(
      "kubectl",
      [
        "port-forward",
        ROUTER_SERVICE_NAME,
        `${this.#localPort}:8080`,
        "-n",
        this.#namespace,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    // Wait for the port to become reachable
    const startTime = Date.now();
    const timeoutMs = this.#portForwardReadyTimeout * 1000;

    while (Date.now() - startTime < timeoutMs) {
      // Check if process died
      if (this.#process.exitCode !== null) {
        const stderr = await this.#collectStderr();
        throw new K8sAgentSandboxError(
          `kubectl port-forward crashed: ${stderr}`,
          "CONNECTION_FAILED",
        );
      }

      // Try to connect
      const reachable = await this.#isPortReachable(this.#localPort);
      if (reachable) {
        this.#baseUrl = `http://127.0.0.1:${this.#localPort}`;
        return this.#baseUrl;
      }

      await sleep(500);
    }

    await this.close();
    throw new K8sAgentSandboxError(
      "Failed to establish kubectl port-forward tunnel within timeout",
      "CONNECTION_FAILED",
    );
  }

  async close(): Promise<void> {
    if (this.#process) {
      try {
        this.#process.kill("SIGTERM");
        // Give it a moment to exit gracefully
        await Promise.race([
          new Promise<void>((resolve) => {
            this.#process?.on("exit", () => resolve());
          }),
          sleep(2000),
        ]);
        // Force kill if still alive
        if (this.#process.exitCode === null) {
          this.#process.kill("SIGKILL");
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== "ESRCH") {
          console.warn(
            `Unexpected error closing kubectl port-forward: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } finally {
        this.#process = null;
        this.#baseUrl = null;
      }
    }
  }

  async verifyConnection(): Promise<void> {
    if (this.#process && this.#process.exitCode !== null) {
      const stderr = await this.#collectStderr();
      await this.close();
      throw new K8sAgentSandboxError(
        `kubectl port-forward crashed: ${stderr}`,
        "CONNECTION_FAILED",
      );
    }
  }

  async #getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          const port = addr.port;
          server.close(() => resolve(port));
        } else {
          server.close(() => reject(new Error("Could not determine port")));
        }
      });
      server.on("error", reject);
    });
  }

  #isPortReachable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => {
        socket.destroy();
        resolve(false);
      });
      socket.setTimeout(100, () => {
        socket.destroy();
        resolve(false);
      });
    });
  }

  async #collectStderr(): Promise<string> {
    if (!this.#process?.stderr) return "(no stderr)";
    const chunks: Buffer[] = [];
    for await (const chunk of this.#process.stderr) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString("utf-8").trim() || "(empty stderr)";
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates the appropriate connection strategy from a config object.
 *
 * @param k8sClient Required for gateway strategy; ignored for direct/tunnel.
 */
export function createConnectionStrategy(
  config: K8sConnectionConfig,
  k8sClient?: K8sClient,
): ConnectionStrategy {
  switch (config.type) {
    case "direct":
      return new DirectConnectionStrategy(config);
    case "gateway":
      if (!k8sClient) {
        throw new K8sAgentSandboxError(
          "Gateway connection requires a K8sClient instance",
          "CONNECTION_FAILED",
        );
      }
      return new GatewayConnectionStrategy(config, k8sClient);
    case "tunnel":
      return new TunnelConnectionStrategy(config);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
