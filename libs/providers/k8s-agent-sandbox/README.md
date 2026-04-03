# @langchain/k8s-agent-sandbox

Kubernetes Agent Sandbox backend for [deepagents](https://github.com/langchain-ai/deepagentsjs).

Provides a `SandboxBackendProtocol` implementation that connects to sandbox pods managed by the [k8s-agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) controller. Agents get isolated Kubernetes pods with command execution and file operations.

## Installation

```bash
npm install @langchain/k8s-agent-sandbox deepagents
```

## Quick Start

### Connect to an existing sandbox

```typescript
import { K8sAgentSandbox } from "@langchain/k8s-agent-sandbox";

const sandbox = K8sAgentSandbox.fromUrl(
  "http://localhost:8080", // sandbox-router URL
  "my-sandbox-abc123",    // sandbox resource name
);
await sandbox.initialize();

const result = await sandbox.execute("python --version");
console.log(result.output); // Python 3.11.x

await sandbox.close();
```

### Create a sandbox from a template

```typescript
const sandbox = await K8sAgentSandbox.create({
  template: "python-sandbox-template",
  namespace: "default",
  deleteOnClose: true, // clean up when done
});

try {
  const result = await sandbox.execute("echo hello");
  console.log(result.output);
} finally {
  await sandbox.close();
}
```

### Use with a DeepAgent

```typescript
import { createDeepAgent } from "deepagents";
import { ChatAnthropic } from "@langchain/anthropic";
import { K8sAgentSandbox } from "@langchain/k8s-agent-sandbox";

const sandbox = await K8sAgentSandbox.create({
  template: "python-sandbox-template",
});

const agent = createDeepAgent({
  model: new ChatAnthropic({ model: "claude-sonnet-4-20250514" }),
  systemPrompt: "You are a coding assistant with sandbox access.",
  backend: sandbox,
});

const result = await agent.invoke({
  messages: [{ role: "user", content: "Create a fibonacci function" }],
});

await sandbox.close();
```

## Connection Modes

### Direct

Connect to a known sandbox-router URL. Use when you have an existing port-forward, ingress, or load balancer.

```typescript
const sandbox = K8sAgentSandbox.fromUrl("http://localhost:8080", "sandbox-id");
```

### Tunnel (default for `create()`)

Automatically sets up `kubectl port-forward` to the sandbox-router service.

```typescript
const sandbox = await K8sAgentSandbox.create({
  template: "my-template",
  connectionConfig: {
    type: "tunnel",
    namespace: "sandbox-ns",
    portForwardReadyTimeout: 30,
  },
});
```

### Gateway

Discovers the sandbox-router IP from a Kubernetes Gateway resource.

```typescript
const sandbox = await K8sAgentSandbox.create({
  template: "my-template",
  connectionConfig: {
    type: "gateway",
    gatewayName: "sandbox-gateway",
    gatewayNamespace: "infra",
  },
});
```

## API Reference

### `K8sAgentSandbox`

Extends `BaseSandbox` from deepagents. Inherits all file operations (read, write, edit, grep, glob, ls) which are implemented via shell commands through `execute()`.

#### Static Methods

| Method | Description |
|--------|-------------|
| `fromUrl(baseUrl, sandboxId, options?)` | Connect to an existing sandbox via direct URL |
| `create(options)` | Provision a new sandbox via K8s API |
| `fromExisting(claimName, options?)` | Attach to an existing SandboxClaim |
| `deleteAll(labels, namespace?)` | Delete all matching SandboxClaims |

#### Instance Methods

| Method | Description |
|--------|-------------|
| `initialize()` | Connect and verify the sandbox is reachable |
| `execute(command)` | Run a shell command |
| `uploadFiles(files)` | Upload files (via base64 + execute) |
| `downloadFiles(paths)` | Download files (via HTTP) |
| `close()` | Close connection, optionally delete sandbox |
| `healthz()` | Check if sandbox is reachable |

#### Properties

| Property | Type | Description |
|----------|------|-------------|
| `id` | `string` | Sandbox resource name |
| `isRunning` | `boolean` | Whether the connection is active |
| `claimName` | `string \| null` | SandboxClaim name if provisioned via claim |
| `namespace` | `string` | Kubernetes namespace |

## Prerequisites

- Kubernetes cluster with [agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) deployed
- `kubectl` configured and accessible (for tunnel mode)
- A SandboxTemplate resource in the cluster

## License

MIT
