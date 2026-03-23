import { describe, expect, it } from "vitest";
import { AgentAdapter } from "../src/agent-adapter";

describe("AgentAdapter agentName validation", () => {
  it("rejects agent name with path traversal characters", () => {
    expect(() => new AgentAdapter("http://localhost:3000", undefined, "../../etc/passwd")).toThrow("Invalid agentName");
  });

  it("rejects agent name with slashes", () => {
    expect(() => new AgentAdapter("http://localhost:3000", undefined, "foo/bar")).toThrow("Invalid agentName");
  });

  it("rejects agent name with backslashes", () => {
    expect(() => new AgentAdapter("http://localhost:3000", undefined, "foo\\bar")).toThrow("Invalid agentName");
  });

  it("rejects agent name with dots", () => {
    expect(() => new AgentAdapter("http://localhost:3000", undefined, "foo..bar")).toThrow("Invalid agentName");
  });

  it("accepts valid agent names", () => {
    expect(() => new AgentAdapter("http://localhost:3000", undefined, "my-agent_01")).not.toThrow();
  });
});
