import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  DirectConnectionStrategy,
  GatewayConnectionStrategy,
  TunnelConnectionStrategy,
  createConnectionStrategy,
} from "./connection.js";
import { K8sAgentSandboxError } from "./types.js";
import type { K8sClient } from "./k8s-client.js";

describe("DirectConnectionStrategy", () => {
  it("should return the base URL", async () => {
    const strategy = new DirectConnectionStrategy({
      type: "direct",
      baseUrl: "http://localhost:8080",
    });
    const url = await strategy.connect();
    expect(url).toBe("http://localhost:8080");
  });

  it("should strip trailing slashes", async () => {
    const strategy = new DirectConnectionStrategy({
      type: "direct",
      baseUrl: "http://localhost:8080///",
    });
    const url = await strategy.connect();
    expect(url).toBe("http://localhost:8080");
  });

  it("should be idempotent", async () => {
    const strategy = new DirectConnectionStrategy({
      type: "direct",
      baseUrl: "http://localhost:8080",
    });
    await strategy.connect();
    await strategy.close();
    const url = await strategy.connect();
    expect(url).toBe("http://localhost:8080");
  });

  it("should not throw on verify or close", async () => {
    const strategy = new DirectConnectionStrategy({
      type: "direct",
      baseUrl: "http://localhost:8080",
    });
    await expect(strategy.verifyConnection()).resolves.toBeUndefined();
    await expect(strategy.close()).resolves.toBeUndefined();
  });
});

describe("GatewayConnectionStrategy", () => {
  let mockK8sClient: K8sClient;

  beforeEach(() => {
    mockK8sClient = {
      waitForGatewayIp: vi.fn().mockResolvedValue("34.56.78.90"),
    } as unknown as K8sClient;
  });

  it("should discover gateway IP and return URL", async () => {
    const strategy = new GatewayConnectionStrategy(
      { type: "gateway", gatewayName: "my-gw" },
      mockK8sClient,
    );
    const url = await strategy.connect();
    expect(url).toBe("http://34.56.78.90");
    expect(mockK8sClient.waitForGatewayIp).toHaveBeenCalledWith(
      "my-gw",
      "default",
      180,
    );
  });

  it("should cache the URL on subsequent calls", async () => {
    const strategy = new GatewayConnectionStrategy(
      { type: "gateway", gatewayName: "my-gw" },
      mockK8sClient,
    );
    await strategy.connect();
    await strategy.connect();
    expect(mockK8sClient.waitForGatewayIp).toHaveBeenCalledTimes(1);
  });

  it("should clear cached URL on close", async () => {
    const strategy = new GatewayConnectionStrategy(
      { type: "gateway", gatewayName: "my-gw" },
      mockK8sClient,
    );
    await strategy.connect();
    await strategy.close();
    await strategy.connect();
    expect(mockK8sClient.waitForGatewayIp).toHaveBeenCalledTimes(2);
  });

  it("should use custom namespace and timeout", async () => {
    const strategy = new GatewayConnectionStrategy(
      {
        type: "gateway",
        gatewayName: "gw-prod",
        gatewayNamespace: "infra",
        gatewayReadyTimeout: 60,
      },
      mockK8sClient,
    );
    await strategy.connect();
    expect(mockK8sClient.waitForGatewayIp).toHaveBeenCalledWith(
      "gw-prod",
      "infra",
      60,
    );
  });
});

describe("TunnelConnectionStrategy", () => {
  // Tunnel tests are limited to configuration-level checks in unit tests.
  // Full port-forward testing requires integration tests.

  it("should use default namespace", () => {
    const strategy = new TunnelConnectionStrategy({ type: "tunnel" });
    // Cannot easily test internals, but verify it constructs without error
    expect(strategy).toBeInstanceOf(TunnelConnectionStrategy);
  });

  it("should accept custom namespace and timeout", () => {
    const strategy = new TunnelConnectionStrategy({
      type: "tunnel",
      namespace: "sandbox-ns",
      portForwardReadyTimeout: 60,
    });
    expect(strategy).toBeInstanceOf(TunnelConnectionStrategy);
  });

  it("close should be safe when no process is running", async () => {
    const strategy = new TunnelConnectionStrategy({ type: "tunnel" });
    await expect(strategy.close()).resolves.toBeUndefined();
  });

  it("verifyConnection should be safe when no process is running", async () => {
    const strategy = new TunnelConnectionStrategy({ type: "tunnel" });
    await expect(strategy.verifyConnection()).resolves.toBeUndefined();
  });
});

describe("createConnectionStrategy", () => {
  it("should create DirectConnectionStrategy", () => {
    const strategy = createConnectionStrategy({
      type: "direct",
      baseUrl: "http://localhost:8080",
    });
    expect(strategy).toBeInstanceOf(DirectConnectionStrategy);
  });

  it("should create GatewayConnectionStrategy with k8sClient", () => {
    const mockClient = {} as K8sClient;
    const strategy = createConnectionStrategy(
      { type: "gateway", gatewayName: "gw" },
      mockClient,
    );
    expect(strategy).toBeInstanceOf(GatewayConnectionStrategy);
  });

  it("should throw if gateway strategy has no k8sClient", () => {
    expect(() =>
      createConnectionStrategy({ type: "gateway", gatewayName: "gw" }),
    ).toThrow(K8sAgentSandboxError);
  });

  it("should create TunnelConnectionStrategy", () => {
    const strategy = createConnectionStrategy({ type: "tunnel" });
    expect(strategy).toBeInstanceOf(TunnelConnectionStrategy);
  });
});
