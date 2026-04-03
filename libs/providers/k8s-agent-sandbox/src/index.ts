/**
 * @langchain/k8s-agent-sandbox
 *
 * Kubernetes Agent Sandbox backend for deepagents.
 *
 * This package provides a k8s-agent-sandbox implementation of the
 * SandboxBackendProtocol, enabling agents to execute commands, read/write
 * files, and manage isolated sandbox environments using Kubernetes-native
 * sandbox pods managed by the agent-sandbox controller.
 *
 * @example
 * ```typescript
 * import { K8sAgentSandbox } from "@langchain/k8s-agent-sandbox";
 * import { createDeepAgent } from "deepagents";
 * import { ChatAnthropic } from "@langchain/anthropic";
 *
 * // Connect to an existing sandbox by URL
 * const sandbox = K8sAgentSandbox.fromUrl(
 *   "http://localhost:8080",
 *   "my-sandbox-id",
 * );
 * await sandbox.initialize();
 *
 * try {
 *   const agent = createDeepAgent({
 *     model: new ChatAnthropic({ model: "claude-sonnet-4-20250514" }),
 *     systemPrompt: "You are a coding assistant with sandbox access.",
 *     backend: sandbox,
 *   });
 *
 *   const result = await agent.invoke({
 *     messages: [new HumanMessage("Create a hello world app")],
 *   });
 * } finally {
 *   await sandbox.close();
 * }
 * ```
 *
 * @example
 * ```typescript
 * // Full lifecycle: create a sandbox from a template
 * const sandbox = await K8sAgentSandbox.create({
 *   template: "python-sandbox-template",
 *   namespace: "default",
 *   deleteOnClose: true,
 * });
 *
 * const result = await sandbox.execute("python --version");
 * console.log(result.output);
 *
 * await sandbox.close(); // deletes the sandbox
 * ```
 *
 * @packageDocumentation
 */

export { K8sAgentSandbox } from "./sandbox.js";

export type {
  K8sAgentSandboxOptions,
  K8sAgentSandboxCreateOptions,
  K8sDirectConnectionConfig,
  K8sGatewayConnectionConfig,
  K8sTunnelConnectionConfig,
  K8sConnectionConfig,
  K8sAgentSandboxErrorCode,
} from "./types.js";

export { K8sAgentSandboxError } from "./types.js";
