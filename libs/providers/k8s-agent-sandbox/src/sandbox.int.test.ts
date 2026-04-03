/**
 * Integration tests for K8sAgentSandbox.
 *
 * These tests require:
 * - A running Kubernetes cluster with agent-sandbox deployed
 * - SANDBOX_ROUTER_URL environment variable (e.g. http://localhost:8080)
 * - SANDBOX_TEMPLATE environment variable (e.g. python-sandbox-template)
 * - Optionally: SANDBOX_NAMESPACE (default: "default")
 *
 * Run with: pnpm test:int
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  sandboxStandardTests,
  withRetry,
} from "@langchain/sandbox-standard-tests/vitest";
import os from "node:os";

import { K8sAgentSandbox } from "./index.js";

const TEST_TIMEOUT = 120_000; // 2 minutes

const CI_LABELS: Record<string, string> = {
  purpose: "integration-test",
  package: "@langchain/k8s-agent-sandbox",
  node: process.version,
  os: os.platform(),
};

const template = process.env.SANDBOX_TEMPLATE;
const namespace = process.env.SANDBOX_NAMESPACE ?? "default";

/**
 * Clean up stale integration-test sandboxes before running tests.
 */
beforeAll(async () => {
  if (!template) return;
  await K8sAgentSandbox.deleteAll(CI_LABELS, namespace);
}, TEST_TIMEOUT);

sandboxStandardTests({
  name: "K8sAgentSandbox",
  timeout: TEST_TIMEOUT,
  createSandbox: async (options) => {
    if (!template) {
      throw new Error(
        "SANDBOX_TEMPLATE environment variable is required for integration tests",
      );
    }
    return K8sAgentSandbox.create({
      template,
      namespace,
      deleteOnClose: true,
      labels: CI_LABELS,
      ...options,
    });
  },
  closeSandbox: (sandbox) => sandbox.close(),
  resolvePath: (name) => name,
});

describe("K8sAgentSandbox Provider-Specific Tests", () => {
  let sandbox: K8sAgentSandbox;

  beforeAll(async () => {
    if (!template) return;
    sandbox = await withRetry(() =>
      K8sAgentSandbox.create({
        template,
        namespace,
        deleteOnClose: true,
        labels: CI_LABELS,
      }),
    );
  }, TEST_TIMEOUT);

  afterAll(async () => {
    try {
      await sandbox?.close();
    } catch {
      // Ignore cleanup errors
    }
  }, TEST_TIMEOUT);

  it(
    "should have a valid sandbox id",
    async () => {
      if (!template) return;
      expect(sandbox.id).toBeTruthy();
      expect(typeof sandbox.id).toBe("string");
    },
    TEST_TIMEOUT,
  );

  it(
    "should report as running after creation",
    async () => {
      if (!template) return;
      expect(sandbox.isRunning).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    "should pass health check",
    async () => {
      if (!template) return;
      const healthy = await sandbox.healthz();
      expect(healthy).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    "should execute a basic command",
    async () => {
      if (!template) return;
      const result = await sandbox.execute("echo 'hello from k8s sandbox'");
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("hello from k8s sandbox");
    },
    TEST_TIMEOUT,
  );

  it(
    "should have a claim name",
    async () => {
      if (!template) return;
      expect(sandbox.claimName).toMatch(/^sandbox-claim-/);
    },
    TEST_TIMEOUT,
  );
});
