import { describe, expect, it } from "vite-plus/test";

import { approvalRequestType, parseApprovalPrompt } from "./approvalPrompt.ts";

describe("NeoPi legacy approval prompt", () => {
  it("retains the reason and all detail lines", () => {
    expect(
      parseApprovalPrompt(
        "Allow tool: bash\nReason: destructive command\nCommand: rm -rf build\nCwd: /repo",
        ["Approve", "Deny"],
      ),
    ).toEqual({
      toolName: "bash",
      requestType: "exec_command_approval",
      detail: "Allow tool: bash\nReason: destructive command\nCommand: rm -rf build\nCwd: /repo",
    });
  });

  it("requires the exact first line and exact pair of ordered options", () => {
    expect(parseApprovalPrompt("Should we run bash?", ["Approve", "Deny"])).toBeUndefined();
    expect(parseApprovalPrompt("Allow tool: bash", ["Deny", "Approve"])).toBeUndefined();
    expect(parseApprovalPrompt("Allow tool:   ", ["Approve", "Deny"])).toBeUndefined();
    expect(parseApprovalPrompt("Prefix Allow tool: bash", ["Approve", "Deny"])).toBeUndefined();
  });

  it.each([
    ["bash", "exec_command_approval"],
    ["edit", "file_change_approval"],
    ["write", "file_change_approval"],
    ["delete", "file_change_approval"],
    ["move", "file_change_approval"],
    ["read", "file_read_approval"],
    ["mcp__server__tool", "mcp_elicitation_approval"],
    ["shell", "permission_approval"],
  ] as const)("maps %s to %s", (tool, kind) => {
    expect(approvalRequestType(tool)).toBe(kind);
  });
});
