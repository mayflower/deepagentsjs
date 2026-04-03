/**
 * Type definitions for the Kubernetes Agent Sandbox backend.
 *
 * This module contains all type definitions for the @langchain/k8s-agent-sandbox
 * package, including connection configuration, sandbox options, and error types.
 */

import { type SandboxErrorCode, SandboxError } from "deepagents";

// ---------------------------------------------------------------------------
// Connection configuration (discriminated union)
// ---------------------------------------------------------------------------

/**
 * Connect directly to a sandbox-router at a known URL.
 *
 * Use this when you already have network access to the sandbox-router
 * service (e.g. via an ingress, load balancer, or local port-forward
 * you manage yourself).
 */
export interface K8sDirectConnectionConfig {
  type: "direct";
  /** Base URL of the sandbox-router, e.g. "http://localhost:8080". */
  baseUrl: string;
  /** Port the sandbox runtime listens on inside the pod. @default 8888 */
  serverPort?: number;
}

/**
 * Discover the sandbox-router URL from a Kubernetes Gateway resource.
 *
 * The provider watches the Gateway until an external IP is assigned,
 * then uses that IP as the base URL.
 */
export interface K8sGatewayConnectionConfig {
  type: "gateway";
  /** Name of the Gateway resource. */
  gatewayName: string;
  /** Namespace of the Gateway resource. @default "default" */
  gatewayNamespace?: string;
  /** Seconds to wait for the Gateway to receive an IP. @default 180 */
  gatewayReadyTimeout?: number;
  /** Port the sandbox runtime listens on inside the pod. @default 8888 */
  serverPort?: number;
}

/**
 * Use `kubectl port-forward` to tunnel traffic to the sandbox-router
 * service inside the cluster.
 *
 * Best for local development against a remote or kind cluster.
 */
export interface K8sTunnelConnectionConfig {
  type: "tunnel";
  /** Kubernetes namespace where the sandbox-router-svc lives. @default "default" */
  namespace?: string;
  /** Seconds to wait for the port-forward to become ready. @default 30 */
  portForwardReadyTimeout?: number;
  /** Port the sandbox runtime listens on inside the pod. @default 8888 */
  serverPort?: number;
}

/**
 * Union of all supported connection strategies.
 */
export type K8sConnectionConfig =
  | K8sDirectConnectionConfig
  | K8sGatewayConnectionConfig
  | K8sTunnelConnectionConfig;

// ---------------------------------------------------------------------------
// Sandbox options
// ---------------------------------------------------------------------------

/**
 * Options for constructing a {@link K8sAgentSandbox} that connects to an
 * already-existing sandbox.
 */
export interface K8sAgentSandboxOptions {
  /** How to reach the sandbox-router. */
  connectionConfig: K8sConnectionConfig;
  /** The Sandbox resource name (not the claim name). */
  sandboxId: string;
  /** Kubernetes namespace of the sandbox. @default "default" */
  namespace?: string;
  /** Default command timeout in seconds. @default 300 */
  defaultTimeout?: number;
  /** Delete the SandboxClaim when {@link K8sAgentSandbox.close} is called. @default false */
  deleteOnClose?: boolean;
  /** The SandboxClaim name, if the sandbox was provisioned via a claim. */
  claimName?: string;
}

/**
 * Options for {@link K8sAgentSandbox.create}, which provisions a new
 * sandbox via the Kubernetes API.
 */
export interface K8sAgentSandboxCreateOptions {
  /** SandboxTemplate name to create the claim from. */
  template: string;
  /** Kubernetes namespace. @default "default" */
  namespace?: string;
  /** Connection strategy. @default tunnel with default settings */
  connectionConfig?: K8sConnectionConfig;
  /** Seconds to wait for the sandbox to become ready. @default 180 */
  sandboxReadyTimeout?: number;
  /** Default command timeout in seconds. @default 300 */
  defaultTimeout?: number;
  /** Delete the SandboxClaim when close() is called. @default true */
  deleteOnClose?: boolean;
  /** Kubernetes labels to attach to the SandboxClaim. */
  labels?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Error codes specific to the k8s-agent-sandbox provider.
 */
export type K8sAgentSandboxErrorCode =
  | SandboxErrorCode
  | "CONNECTION_FAILED"
  | "SANDBOX_NOT_REACHABLE"
  | "HTTP_ERROR"
  | "K8S_API_ERROR"
  | "SANDBOX_CREATION_FAILED"
  | "SANDBOX_NOT_FOUND";

const K8S_SANDBOX_ERROR_SYMBOL = Symbol.for("k8s.agent.sandbox.error");

/**
 * Custom error class for k8s-agent-sandbox operations.
 */
export class K8sAgentSandboxError extends SandboxError {
  [K8S_SANDBOX_ERROR_SYMBOL] = true as const;

  override readonly name = "K8sAgentSandboxError";

  constructor(
    message: string,
    public readonly code: K8sAgentSandboxErrorCode,
    public override readonly cause?: Error,
  ) {
    super(message, code as SandboxErrorCode, cause);
    Object.setPrototypeOf(this, K8sAgentSandboxError.prototype);
  }

  static isInstance(error: unknown): error is K8sAgentSandboxError {
    return (
      typeof error === "object" &&
      error !== null &&
      (error as Record<symbol, unknown>)[K8S_SANDBOX_ERROR_SYMBOL] === true
    );
  }
}
