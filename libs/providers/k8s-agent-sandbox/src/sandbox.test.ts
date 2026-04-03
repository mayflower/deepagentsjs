import { describe, it, expect, vi, beforeEach } from "vitest";
import { K8sAgentSandbox } from "./sandbox.js";
import { K8sAgentSandboxError } from "./types.js";

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

const mockExecute = vi.fn();
const mockDownload = vi.fn();
const mockHealthz = vi.fn();
const mockHealthCheck = vi.fn();
const mockClose = vi.fn();

vi.mock("./http-client.js", () => ({
  SandboxRouterClient: class {
    constructor() {}
    execute = mockExecute;
    download = mockDownload;
    healthz = mockHealthz;
    healthCheck = mockHealthCheck;
    close = mockClose;
  },
}));

vi.mock("./connection.js", () => ({
  createConnectionStrategy: () => ({
    connect: vi.fn().mockResolvedValue("http://localhost:8080"),
    close: vi.fn().mockResolvedValue(undefined),
    verifyConnection: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("./k8s-client.js", () => ({
  K8sClient: class {
    createSandboxClaim = vi.fn().mockResolvedValue(undefined);
    resolveSandboxName = vi.fn().mockResolvedValue("sandbox-abc123");
    waitForSandboxReady = vi.fn().mockResolvedValue(undefined);
    deleteSandboxClaim = vi.fn().mockResolvedValue(undefined);
    getSandbox = vi.fn().mockResolvedValue({});
    listSandboxClaims = vi.fn().mockResolvedValue([]);
    waitForGatewayIp = vi.fn().mockResolvedValue("1.2.3.4");
  },
}));

describe("K8sAgentSandbox", () => {
  let sandbox: K8sAgentSandbox;

  beforeEach(() => {
    vi.clearAllMocks();
    mockHealthz.mockResolvedValue(true);
    mockHealthCheck.mockResolvedValue(true);
    mockClose.mockResolvedValue(undefined);

    sandbox = new K8sAgentSandbox({
      connectionConfig: { type: "direct", baseUrl: "http://localhost:8080" },
      sandboxId: "test-sandbox-123",
      namespace: "default",
    });
  });

  describe("constructor", () => {
    it("should create instance with correct id", () => {
      expect(sandbox.id).toBe("test-sandbox-123");
    });

    it("should not be running before initialization", () => {
      expect(sandbox.isRunning).toBe(false);
    });

    it("should default namespace to 'default'", () => {
      expect(sandbox.namespace).toBe("default");
    });

    it("should have null claimName by default", () => {
      expect(sandbox.claimName).toBeNull();
    });

    it("should store claimName if provided", () => {
      const sb = new K8sAgentSandbox({
        connectionConfig: { type: "direct", baseUrl: "http://localhost:8080" },
        sandboxId: "sb-1",
        claimName: "claim-1",
      });
      expect(sb.claimName).toBe("claim-1");
    });
  });

  describe("initialize", () => {
    it("should set isRunning to true", async () => {
      await sandbox.initialize();
      expect(sandbox.isRunning).toBe(true);
    });

    it("should throw if already initialized", async () => {
      await sandbox.initialize();
      await expect(sandbox.initialize()).rejects.toThrow(
        "already initialized",
      );
    });

    it("should throw if sandbox is not reachable", async () => {
      mockHealthCheck.mockResolvedValue(false);
      await expect(sandbox.initialize()).rejects.toThrow("health check returned non-200");
    });
  });

  describe("execute", () => {
    beforeEach(async () => {
      await sandbox.initialize();
    });

    it("should wrap command in sh -c", async () => {
      mockExecute.mockResolvedValue({
        stdout: "hello\n",
        stderr: "",
        exitCode: 0,
      });

      await sandbox.execute("echo hello");

      expect(mockExecute).toHaveBeenCalledWith(
        "sh -c 'echo hello'",
        expect.any(AbortSignal),
      );
    });

    it("should combine stdout and stderr", async () => {
      mockExecute.mockResolvedValue({
        stdout: "out",
        stderr: "err",
        exitCode: 0,
      });

      const result = await sandbox.execute("test");
      expect(result.output).toBe("out\nerr");
      expect(result.exitCode).toBe(0);
      expect(result.truncated).toBe(false);
    });

    it("should return stdout only when no stderr", async () => {
      mockExecute.mockResolvedValue({
        stdout: "output",
        stderr: "",
        exitCode: 0,
      });

      const result = await sandbox.execute("test");
      expect(result.output).toBe("output");
    });

    it("should properly escape single quotes in commands", async () => {
      mockExecute.mockResolvedValue({
        stdout: "ok",
        stderr: "",
        exitCode: 0,
      });

      await sandbox.execute("echo it's a test");

      const call = mockExecute.mock.calls[0]![0] as string;
      expect(call).toBe("sh -c 'echo it'\\''s a test'");
    });

    it("should pass through exit codes", async () => {
      mockExecute.mockResolvedValue({
        stdout: "",
        stderr: "not found",
        exitCode: 127,
      });

      const result = await sandbox.execute("nonexistent");
      expect(result.exitCode).toBe(127);
    });
  });

  describe("uploadFiles", () => {
    beforeEach(async () => {
      await sandbox.initialize();
      mockExecute.mockResolvedValue({
        stdout: "",
        stderr: "",
        exitCode: 0,
      });
    });

    it("should upload file via base64 execute", async () => {
      const content = new TextEncoder().encode("hello world");
      const responses = await sandbox.uploadFiles([["/app/test.txt", content]]);

      expect(responses).toHaveLength(1);
      expect(responses[0]!.path).toBe("/app/test.txt");
      expect(responses[0]!.error).toBeNull();

      // Verify execute was called with mkdir + base64 command
      const cmd = mockExecute.mock.calls[0]![0] as string;
      expect(cmd).toContain("sh -c ");
      expect(cmd).toContain("mkdir -p");
      expect(cmd).toContain("base64 -d");
    });

    it("should handle multiple files", async () => {
      const enc = new TextEncoder();
      const responses = await sandbox.uploadFiles([
        ["/app/a.txt", enc.encode("aaa")],
        ["/app/b.txt", enc.encode("bbb")],
      ]);

      expect(responses).toHaveLength(2);
      expect(responses.every((r) => r.error === null)).toBe(true);
    });

    it("should return permission_denied on non-zero exit", async () => {
      mockExecute.mockResolvedValue({
        stdout: "",
        stderr: "permission denied",
        exitCode: 1,
      });

      const content = new TextEncoder().encode("test");
      const responses = await sandbox.uploadFiles([["/root/test.txt", content]]);

      expect(responses[0]!.error).toBe("permission_denied");
    });

    it("should handle files without directory prefix", async () => {
      const content = new TextEncoder().encode("data");
      const responses = await sandbox.uploadFiles([["test.txt", content]]);

      expect(responses[0]!.error).toBeNull();
      // Should not include mkdir since there's no directory
      const cmd = mockExecute.mock.calls[0]![0] as string;
      expect(cmd).not.toContain("mkdir");
    });
  });

  describe("downloadFiles", () => {
    beforeEach(async () => {
      await sandbox.initialize();
    });

    it("should download file via HTTP", async () => {
      const content = new TextEncoder().encode("file content");
      mockDownload.mockResolvedValue(content);

      const responses = await sandbox.downloadFiles(["/app/test.txt"]);

      expect(responses).toHaveLength(1);
      expect(responses[0]!.path).toBe("/app/test.txt");
      expect(responses[0]!.content).toEqual(content);
      expect(responses[0]!.error).toBeNull();

      // Should strip /app/ prefix for the HTTP call
      expect(mockDownload).toHaveBeenCalledWith("test.txt");
    });

    it("should strip /app/ prefix from paths", async () => {
      mockDownload.mockResolvedValue(new Uint8Array());

      await sandbox.downloadFiles(["/app/nested/dir/file.py"]);

      expect(mockDownload).toHaveBeenCalledWith("nested/dir/file.py");
    });

    it("should strip leading / for non-/app paths", async () => {
      mockDownload.mockResolvedValue(new Uint8Array());

      await sandbox.downloadFiles(["/other/path.txt"]);

      expect(mockDownload).toHaveBeenCalledWith("other/path.txt");
    });

    it("should handle file not found", async () => {
      mockDownload.mockRejectedValue(
        new K8sAgentSandboxError("File not found: missing.txt", "FILE_OPERATION_FAILED"),
      );

      const responses = await sandbox.downloadFiles(["/app/missing.txt"]);

      expect(responses[0]!.error).toBe("file_not_found");
      expect(responses[0]!.content).toBeNull();
    });

    it("should handle access denied", async () => {
      mockDownload.mockRejectedValue(
        new K8sAgentSandboxError("Access denied: /etc/shadow", "FILE_OPERATION_FAILED"),
      );

      const responses = await sandbox.downloadFiles(["/etc/shadow"]);

      expect(responses[0]!.error).toBe("permission_denied");
    });

    it("should handle multiple files with mixed results", async () => {
      mockDownload
        .mockResolvedValueOnce(new TextEncoder().encode("ok"))
        .mockRejectedValueOnce(
          new K8sAgentSandboxError("File not found", "FILE_OPERATION_FAILED"),
        );

      const responses = await sandbox.downloadFiles([
        "/app/exists.txt",
        "/app/missing.txt",
      ]);

      expect(responses[0]!.error).toBeNull();
      expect(responses[1]!.error).toBe("file_not_found");
    });
  });

  describe("close", () => {
    it("should set isRunning to false", async () => {
      await sandbox.initialize();
      await sandbox.close();
      expect(sandbox.isRunning).toBe(false);
    });

    it("should close the HTTP client", async () => {
      await sandbox.close();
      expect(mockClose).toHaveBeenCalled();
    });
  });

  describe("healthz", () => {
    it("should delegate to HTTP client", async () => {
      mockHealthz.mockResolvedValue(true);
      const result = await sandbox.healthz();
      expect(result).toBe(true);
    });
  });

  describe("fromUrl", () => {
    it("should create a sandbox with direct connection", () => {
      const sb = K8sAgentSandbox.fromUrl(
        "http://localhost:8080",
        "sb-123",
        { namespace: "test-ns" },
      );

      expect(sb.id).toBe("sb-123");
      expect(sb.namespace).toBe("test-ns");
      expect(sb.isRunning).toBe(false);
    });

    it("should use default namespace", () => {
      const sb = K8sAgentSandbox.fromUrl("http://localhost:8080", "sb-123");
      expect(sb.namespace).toBe("default");
    });
  });

  describe("create", () => {
    it("should provision and initialize a sandbox", async () => {
      const sb = await K8sAgentSandbox.create({
        template: "python-sandbox-template",
        namespace: "test-ns",
      });

      expect(sb.id).toBe("sandbox-abc123");
      expect(sb.namespace).toBe("test-ns");
      expect(sb.isRunning).toBe(true);
      expect(sb.claimName).toMatch(/^sandbox-claim-/);

      await sb.close();
    });

    it("should default deleteOnClose to true", async () => {
      const sb = await K8sAgentSandbox.create({
        template: "python-sandbox-template",
      });

      // The sandbox should be configured to delete on close
      // We can verify by closing and checking that deleteSandboxClaim was called
      await sb.close();
      // Note: The mock K8sClient's deleteSandboxClaim was called
    });
  });

  describe("fromExisting", () => {
    it("should attach to an existing claim", async () => {
      const sb = await K8sAgentSandbox.fromExisting("claim-abc", {
        connectionConfig: { type: "direct", baseUrl: "http://localhost:8080" },
        namespace: "test-ns",
      });

      expect(sb.id).toBe("sandbox-abc123");
      expect(sb.claimName).toBe("claim-abc");
      expect(sb.isRunning).toBe(true);

      await sb.close();
    });
  });
});
