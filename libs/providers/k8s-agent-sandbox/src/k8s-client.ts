/**
 * Kubernetes CRD operations for Agent Sandbox lifecycle management.
 *
 * Provides watch-based operations for SandboxClaim creation, readiness
 * polling, and deletion via the Kubernetes custom resource API.
 */

import * as k8s from "@kubernetes/client-node";
import { K8sAgentSandboxError, type K8sAgentSandboxErrorCode } from "./types.js";

// ---------------------------------------------------------------------------
// CRD API constants
// ---------------------------------------------------------------------------

const CLAIM_API_GROUP = "extensions.agents.x-k8s.io";
const CLAIM_API_VERSION = "v1alpha1";
const CLAIM_PLURAL = "sandboxclaims";

const SANDBOX_API_GROUP = "agents.x-k8s.io";
const SANDBOX_API_VERSION = "v1alpha1";
const SANDBOX_PLURAL = "sandboxes";

const GATEWAY_API_GROUP = "gateway.networking.k8s.io";
const GATEWAY_API_VERSION = "v1";
const GATEWAY_PLURAL = "gateways";

// ---------------------------------------------------------------------------
// K8s watch event types
// ---------------------------------------------------------------------------

interface WatchEvent<T = Record<string, unknown>> {
  type: "ADDED" | "MODIFIED" | "DELETED" | "ERROR";
  object: T;
}

interface SandboxClaimStatus {
  sandbox?: { name?: string };
}

interface SandboxCondition {
  type: string;
  status: string;
}

interface SandboxStatus {
  conditions?: SandboxCondition[];
}

interface GatewayAddress {
  value?: string;
}

interface GatewayStatus {
  addresses?: GatewayAddress[];
}

// ---------------------------------------------------------------------------
// WatchUntil options
// ---------------------------------------------------------------------------

interface WatchUntilOptions<T> {
  path: string;
  fieldSelector: string;
  timeoutSeconds: number;
  timeoutError: K8sAgentSandboxError;
  deletedError?: K8sAgentSandboxError;
  streamEndedMessage: string;
  errorCode: K8sAgentSandboxErrorCode;
  extract: (event: WatchEvent) => T | undefined;
}

// ---------------------------------------------------------------------------
// K8sClient
// ---------------------------------------------------------------------------

export class K8sClient {
  #customApi: k8s.CustomObjectsApi;
  #watch: k8s.Watch;

  constructor(kubeConfig?: k8s.KubeConfig) {
    const kc = kubeConfig ?? new k8s.KubeConfig();
    if (!kubeConfig) {
      try {
        kc.loadFromCluster();
      } catch {
        kc.loadFromDefault();
      }
    }
    this.#customApi = kc.makeApiClient(k8s.CustomObjectsApi);
    this.#watch = new k8s.Watch(kc);
  }

  /**
   * Creates a SandboxClaim custom resource.
   */
  async createSandboxClaim(
    name: string,
    template: string,
    namespace: string,
    options?: { labels?: Record<string, string>; annotations?: Record<string, string> },
  ): Promise<void> {
    const metadata: Record<string, unknown> = {
      name,
      annotations: options?.annotations ?? {},
    };
    if (options?.labels) {
      metadata.labels = options.labels;
    }

    const manifest = {
      apiVersion: `${CLAIM_API_GROUP}/${CLAIM_API_VERSION}`,
      kind: "SandboxClaim",
      metadata,
      spec: {
        sandboxTemplateRef: { name: template },
      },
    };

    try {
      await this.#customApi.createNamespacedCustomObject({
        group: CLAIM_API_GROUP,
        version: CLAIM_API_VERSION,
        namespace,
        plural: CLAIM_PLURAL,
        body: manifest,
      });
    } catch (err) {
      throw new K8sAgentSandboxError(
        `Failed to create SandboxClaim '${name}': ${err instanceof Error ? err.message : String(err)}`,
        "K8S_API_ERROR",
        err instanceof Error ? err : undefined,
      );
    }
  }

  /**
   * Watches the SandboxClaim until `status.sandbox.name` is populated,
   * then returns the resolved Sandbox name.
   */
  async resolveSandboxName(
    claimName: string,
    namespace: string,
    timeoutSeconds: number,
  ): Promise<string> {
    const path = `/apis/${CLAIM_API_GROUP}/${CLAIM_API_VERSION}/namespaces/${namespace}/${CLAIM_PLURAL}`;

    return this.#watchUntil({
      path,
      fieldSelector: `metadata.name=${claimName}`,
      timeoutSeconds,
      timeoutError: new K8sAgentSandboxError(
        `Could not resolve sandbox name from claim '${claimName}' within ${timeoutSeconds}s`,
        "SANDBOX_CREATION_FAILED",
      ),
      deletedError: new K8sAgentSandboxError(
        `SandboxClaim '${claimName}' was deleted while resolving sandbox name`,
        "SANDBOX_NOT_FOUND",
      ),
      streamEndedMessage: `Watch stream for SandboxClaim '${claimName}' ended before sandbox name was resolved`,
      errorCode: "K8S_API_ERROR",
      extract: (event) => {
        const status = (event.object as Record<string, unknown>)
          .status as SandboxClaimStatus | undefined;
        return status?.sandbox?.name || undefined;
      },
    });
  }

  /**
   * Watches the Sandbox resource until condition type=Ready status=True.
   */
  async waitForSandboxReady(
    sandboxName: string,
    namespace: string,
    timeoutSeconds: number,
  ): Promise<void> {
    const path = `/apis/${SANDBOX_API_GROUP}/${SANDBOX_API_VERSION}/namespaces/${namespace}/${SANDBOX_PLURAL}`;

    await this.#watchUntil<true>({
      path,
      fieldSelector: `metadata.name=${sandboxName}`,
      timeoutSeconds,
      timeoutError: new K8sAgentSandboxError(
        `Sandbox '${sandboxName}' did not become ready within ${timeoutSeconds}s`,
        "SANDBOX_CREATION_FAILED",
      ),
      deletedError: new K8sAgentSandboxError(
        `Sandbox '${sandboxName}' was deleted before becoming ready`,
        "SANDBOX_NOT_FOUND",
      ),
      streamEndedMessage: `Watch stream for Sandbox '${sandboxName}' ended before it became ready`,
      errorCode: "K8S_API_ERROR",
      extract: (event) => {
        const status = (event.object as Record<string, unknown>)
          .status as SandboxStatus | undefined;
        const conditions = status?.conditions ?? [];
        const ready = conditions.find(
          (c) => c.type === "Ready" && c.status === "True",
        );
        return ready ? true as const : undefined;
      },
    });
  }

  /**
   * Deletes a SandboxClaim. Silently ignores 404 (already deleted).
   */
  async deleteSandboxClaim(name: string, namespace: string): Promise<void> {
    try {
      await this.#customApi.deleteNamespacedCustomObject({
        group: CLAIM_API_GROUP,
        version: CLAIM_API_VERSION,
        namespace,
        plural: CLAIM_PLURAL,
        name,
      });
    } catch (err) {
      const status = (err as { response?: { statusCode?: number } })?.response
        ?.statusCode;
      if (status !== 404) {
        throw new K8sAgentSandboxError(
          `Failed to delete SandboxClaim '${name}': ${err instanceof Error ? err.message : String(err)}`,
          "K8S_API_ERROR",
          err instanceof Error ? err : undefined,
        );
      }
    }
  }

  /**
   * Gets a Sandbox resource. Returns null if not found.
   */
  async getSandbox(
    name: string,
    namespace: string,
  ): Promise<Record<string, unknown> | null> {
    try {
      const resp = await this.#customApi.getNamespacedCustomObject({
        group: SANDBOX_API_GROUP,
        version: SANDBOX_API_VERSION,
        namespace,
        plural: SANDBOX_PLURAL,
        name,
      });
      return resp as Record<string, unknown>;
    } catch (err) {
      const status = (err as { response?: { statusCode?: number } })?.response
        ?.statusCode;
      if (status === 404) return null;
      throw new K8sAgentSandboxError(
        `Failed to get Sandbox '${name}': ${err instanceof Error ? err.message : String(err)}`,
        "K8S_API_ERROR",
        err instanceof Error ? err : undefined,
      );
    }
  }

  /**
   * Lists all SandboxClaim names in a namespace.
   */
  async listSandboxClaims(namespace: string): Promise<string[]> {
    try {
      const resp = await this.#customApi.listNamespacedCustomObject({
        group: CLAIM_API_GROUP,
        version: CLAIM_API_VERSION,
        namespace,
        plural: CLAIM_PLURAL,
      });
      const body = resp as { items?: Array<{ metadata?: { name?: string } }> };
      return (body.items ?? [])
        .map((item) => item.metadata?.name)
        .filter((n): n is string => !!n);
    } catch (err) {
      throw new K8sAgentSandboxError(
        `Failed to list SandboxClaims: ${err instanceof Error ? err.message : String(err)}`,
        "K8S_API_ERROR",
        err instanceof Error ? err : undefined,
      );
    }
  }

  /**
   * Watches a Gateway resource until an external IP is assigned.
   */
  async waitForGatewayIp(
    gatewayName: string,
    namespace: string,
    timeoutSeconds: number,
  ): Promise<string> {
    const path = `/apis/${GATEWAY_API_GROUP}/${GATEWAY_API_VERSION}/namespaces/${namespace}/${GATEWAY_PLURAL}`;

    return this.#watchUntil({
      path,
      fieldSelector: `metadata.name=${gatewayName}`,
      timeoutSeconds,
      timeoutError: new K8sAgentSandboxError(
        `Gateway '${gatewayName}' did not receive an IP within ${timeoutSeconds}s`,
        "CONNECTION_FAILED",
      ),
      streamEndedMessage: `Watch stream for Gateway '${gatewayName}' ended before an IP was assigned`,
      errorCode: "CONNECTION_FAILED",
      extract: (event) => {
        const status = (event.object as Record<string, unknown>)
          .status as GatewayStatus | undefined;
        return status?.addresses?.[0]?.value || undefined;
      },
    });
  }

  // -------------------------------------------------------------------------
  // Private watch helper
  // -------------------------------------------------------------------------

  /**
   * Generic watch-until-condition helper that handles timeout, abort,
   * deletion, and stream-end scenarios in one place.
   */
  async #watchUntil<T>(opts: WatchUntilOptions<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let watchReq: { abort: () => void } | undefined;
      let settled = false;

      const settle = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          watchReq?.abort();
        }
      };

      const timer = setTimeout(() => {
        settle();
        reject(opts.timeoutError);
      }, opts.timeoutSeconds * 1000);

      this.#watch
        .watch(
          opts.path,
          { fieldSelector: opts.fieldSelector },
          (phase: string, obj: Record<string, unknown>) => {
            if (settled) return;
            const event = { type: phase, object: obj } as WatchEvent;

            if (event.type === "DELETED" && opts.deletedError) {
              settle();
              reject(opts.deletedError);
              return;
            }

            if (event.type === "ADDED" || event.type === "MODIFIED") {
              const value = opts.extract(event);
              if (value !== undefined) {
                settle();
                resolve(value);
              }
            }
          },
          (err) => {
            if (settled) return;
            settle();
            reject(
              new K8sAgentSandboxError(
                err
                  ? `Watch error: ${err instanceof Error ? err.message : String(err)}`
                  : opts.streamEndedMessage,
                opts.errorCode,
                err instanceof Error ? err : undefined,
              ),
            );
          },
        )
        .then((req) => {
          watchReq = req;
        })
        .catch((err) => {
          if (settled) return;
          settle();
          reject(
            new K8sAgentSandboxError(
              `Failed to start watch: ${err instanceof Error ? err.message : String(err)}`,
              opts.errorCode,
              err instanceof Error ? err : undefined,
            ),
          );
        });
    });
  }
}
