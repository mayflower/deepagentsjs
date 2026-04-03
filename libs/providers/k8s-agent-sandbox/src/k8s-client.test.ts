import { describe, it, expect, vi, beforeEach } from "vitest";
import { K8sClient } from "./k8s-client.js";
import { K8sAgentSandboxError } from "./types.js";

// ---------------------------------------------------------------------------
// Mock @kubernetes/client-node
// ---------------------------------------------------------------------------

const mockCreateNamespacedCustomObject = vi.fn();
const mockDeleteNamespacedCustomObject = vi.fn();
const mockGetNamespacedCustomObject = vi.fn();
const mockListNamespacedCustomObject = vi.fn();

let watchCallback: ((phase: string, obj: Record<string, unknown>) => void) | null = null;
const mockWatchFn = vi.fn();

vi.mock("@kubernetes/client-node", () => {
  class MockKubeConfig {
    loadFromCluster() {
      throw new Error("not in cluster");
    }
    loadFromDefault() {
      // noop
    }
    makeApiClient() {
      return {
        createNamespacedCustomObject: mockCreateNamespacedCustomObject,
        deleteNamespacedCustomObject: mockDeleteNamespacedCustomObject,
        getNamespacedCustomObject: mockGetNamespacedCustomObject,
        listNamespacedCustomObject: mockListNamespacedCustomObject,
      };
    }
  }

  class MockWatch {
    constructor(_kc: unknown) {}

    watch(
      _path: string,
      _queryParams: unknown,
      callback: (phase: string, obj: Record<string, unknown>) => void,
      done: (err?: unknown) => void,
    ) {
      watchCallback = callback;
      return mockWatchFn(_path, _queryParams, callback, done);
    }
  }

  return {
    KubeConfig: MockKubeConfig,
    CustomObjectsApi: class {},
    Watch: MockWatch,
  };
});

describe("K8sClient", () => {
  let client: K8sClient;

  beforeEach(() => {
    vi.clearAllMocks();
    watchCallback = null;
    // Default: watch returns a resolved promise (the request object)
    mockWatchFn.mockResolvedValue({ abort: vi.fn() });
    client = new K8sClient();
  });

  describe("createSandboxClaim", () => {
    it("should create a SandboxClaim with correct manifest", async () => {
      mockCreateNamespacedCustomObject.mockResolvedValue({});

      await client.createSandboxClaim("test-claim", "my-template", "default", {
        labels: { app: "test" },
      });

      expect(mockCreateNamespacedCustomObject).toHaveBeenCalledWith(
        expect.objectContaining({
          group: "extensions.agents.x-k8s.io",
          version: "v1alpha1",
          namespace: "default",
          plural: "sandboxclaims",
          body: expect.objectContaining({
            kind: "SandboxClaim",
            metadata: expect.objectContaining({
              name: "test-claim",
              labels: { app: "test" },
            }),
            spec: { sandboxTemplateRef: { name: "my-template" } },
          }),
        }),
      );
    });

    it("should throw K8sAgentSandboxError on API failure", async () => {
      mockCreateNamespacedCustomObject.mockRejectedValue(
        new Error("forbidden"),
      );

      await expect(
        client.createSandboxClaim("test-claim", "tmpl", "default"),
      ).rejects.toThrow(K8sAgentSandboxError);
    });
  });

  describe("resolveSandboxName", () => {
    it("should resolve sandbox name from claim status", async () => {
      const promise = client.resolveSandboxName("claim-1", "default", 30);

      // Simulate watch event with sandbox name in status
      watchCallback?.("ADDED", {
        status: { sandbox: { name: "sandbox-abc123" } },
      });

      await expect(promise).resolves.toBe("sandbox-abc123");
    });

    it("should reject if claim is deleted", async () => {
      const promise = client.resolveSandboxName("claim-1", "default", 30);

      watchCallback?.("DELETED", {});

      await expect(promise).rejects.toThrow("was deleted");
    });

    it("should reject on timeout", async () => {
      vi.useFakeTimers();

      const promise = client.resolveSandboxName("claim-1", "default", 1);

      vi.advanceTimersByTime(1500);

      await expect(promise).rejects.toThrow("within 1s");

      vi.useRealTimers();
    });
  });

  describe("waitForSandboxReady", () => {
    it("should resolve when Ready condition is True", async () => {
      const promise = client.waitForSandboxReady("sb-1", "default", 30);

      watchCallback?.("MODIFIED", {
        status: {
          conditions: [{ type: "Ready", status: "True" }],
        },
      });

      await expect(promise).resolves.toBeUndefined();
    });

    it("should not resolve on non-ready conditions", async () => {
      vi.useFakeTimers();

      const promise = client.waitForSandboxReady("sb-1", "default", 1);

      watchCallback?.("MODIFIED", {
        status: {
          conditions: [{ type: "Ready", status: "False" }],
        },
      });

      vi.advanceTimersByTime(1500);

      await expect(promise).rejects.toThrow("did not become ready");

      vi.useRealTimers();
    });

    it("should reject if sandbox is deleted", async () => {
      const promise = client.waitForSandboxReady("sb-1", "default", 30);

      watchCallback?.("DELETED", {});

      await expect(promise).rejects.toThrow("was deleted");
    });
  });

  describe("deleteSandboxClaim", () => {
    it("should delete a SandboxClaim", async () => {
      mockDeleteNamespacedCustomObject.mockResolvedValue({});

      await client.deleteSandboxClaim("claim-1", "default");

      expect(mockDeleteNamespacedCustomObject).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "claim-1",
          namespace: "default",
        }),
      );
    });

    it("should silently ignore 404", async () => {
      mockDeleteNamespacedCustomObject.mockRejectedValue({
        response: { statusCode: 404 },
      });

      await expect(
        client.deleteSandboxClaim("gone", "default"),
      ).resolves.toBeUndefined();
    });

    it("should throw on other errors", async () => {
      mockDeleteNamespacedCustomObject.mockRejectedValue(
        new Error("server error"),
      );

      await expect(
        client.deleteSandboxClaim("claim-1", "default"),
      ).rejects.toThrow(K8sAgentSandboxError);
    });
  });

  describe("getSandbox", () => {
    it("should return sandbox object", async () => {
      const sandbox = { metadata: { name: "sb-1" } };
      mockGetNamespacedCustomObject.mockResolvedValue(sandbox);

      const result = await client.getSandbox("sb-1", "default");
      expect(result).toEqual(sandbox);
    });

    it("should return null for 404", async () => {
      mockGetNamespacedCustomObject.mockRejectedValue({
        response: { statusCode: 404 },
      });

      const result = await client.getSandbox("gone", "default");
      expect(result).toBeNull();
    });
  });

  describe("listSandboxClaims", () => {
    it("should return claim names", async () => {
      mockListNamespacedCustomObject.mockResolvedValue({
        items: [
          { metadata: { name: "claim-a" } },
          { metadata: { name: "claim-b" } },
        ],
      });

      const result = await client.listSandboxClaims("default");
      expect(result).toEqual(["claim-a", "claim-b"]);
    });

    it("should handle empty list", async () => {
      mockListNamespacedCustomObject.mockResolvedValue({ items: [] });

      const result = await client.listSandboxClaims("default");
      expect(result).toEqual([]);
    });
  });

  describe("waitForGatewayIp", () => {
    it("should resolve with gateway IP", async () => {
      const promise = client.waitForGatewayIp("gw-1", "default", 30);

      watchCallback?.("MODIFIED", {
        status: { addresses: [{ value: "34.56.78.90" }] },
      });

      await expect(promise).resolves.toBe("34.56.78.90");
    });

    it("should reject on timeout", async () => {
      vi.useFakeTimers();

      const promise = client.waitForGatewayIp("gw-1", "default", 1);

      vi.advanceTimersByTime(1500);

      await expect(promise).rejects.toThrow("did not receive an IP");

      vi.useRealTimers();
    });
  });
});
