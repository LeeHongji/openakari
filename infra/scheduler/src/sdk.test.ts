/** Tests for sdk.ts: OrientTurnTracker and SDK utility functions. */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OrientTurnTracker } from "./sdk.js";

describe("OrientTurnTracker", () => {
  let tracker: OrientTurnTracker;

  beforeEach(() => {
    tracker = new OrientTurnTracker();
  });

  describe("onNewTurn", () => {
    it("increments assistant turn count", () => {
      tracker.onNewTurn();
      tracker.onTool("Skill", { skill: "orient" });
      tracker.onNewTurn();
      tracker.onTool("Read", { filePath: "/test" });
      tracker.finalize();
      expect(tracker.orientTurns).toBe(1);
    });

    it("tracks multiple turns correctly", () => {
      tracker.onNewTurn();
      tracker.onTool("Skill", { skill: "orient" });
      tracker.onNewTurn();
      tracker.onNewTurn();
      tracker.onNewTurn();
      tracker.onTool("Edit", { filePath: "/test" });
      expect(tracker.orientTurns).toBe(3);
    });
  });

  describe("orient detection", () => {
    it("detects orient skill start", () => {
      tracker.onNewTurn();
      tracker.onTool("Skill", { skill: "orient" });
      tracker.onNewTurn();
      tracker.onTool("Edit", { filePath: "/test" });
      expect(tracker.orientTurns).toBe(1);
    });

    it("detects orient-simple skill variant", () => {
      tracker.onNewTurn();
      tracker.onTool("Skill", { skill: "orient-simple" });
      tracker.onNewTurn();
      tracker.onTool("Edit", { filePath: "/test" });
      expect(tracker.orientTurns).toBe(1);
    });

    it("ignores non-orient skills", () => {
      tracker.onNewTurn();
      tracker.onTool("Skill", { skill: "compound" });
      tracker.onNewTurn();
      tracker.onTool("Edit", { filePath: "/test" });
      expect(tracker.orientTurns).toBeUndefined();
    });

    it("only detects first orient skill", () => {
      tracker.onNewTurn();
      tracker.onTool("Skill", { skill: "orient" });
      tracker.onNewTurn();
      tracker.onTool("Skill", { skill: "orient" });
      tracker.onNewTurn();
      tracker.onTool("Edit", { filePath: "/test" });
      expect(tracker.orientTurns).toBe(2);
    });
  });

  describe("execution phase detection", () => {
    it("detects Edit tool as execution phase start", () => {
      tracker.onNewTurn();
      tracker.onTool("Skill", { skill: "orient" });
      tracker.onNewTurn();
      tracker.onTool("Edit", { filePath: "/test", oldString: "a", newString: "b" });
      expect(tracker.orientTurns).toBe(1);
    });

    it("detects Write tool as execution phase start", () => {
      tracker.onNewTurn();
      tracker.onTool("Skill", { skill: "orient" });
      tracker.onNewTurn();
      tracker.onTool("Write", { filePath: "/test", content: "hello" });
      expect(tracker.orientTurns).toBe(1);
    });

    it("does not detect TodoWrite as execution phase (used during orient for progress tracking)", () => {
      tracker.onNewTurn();
      tracker.onTool("Skill", { skill: "orient" });
      tracker.onNewTurn();
      tracker.onTool("TodoWrite", { todos: [] });
      expect(tracker.orientTurns).toBeUndefined();
    });

    it("does not detect Read as execution phase", () => {
      tracker.onNewTurn();
      tracker.onTool("Skill", { skill: "orient" });
      tracker.onNewTurn();
      tracker.onTool("Read", { filePath: "/test" });
      expect(tracker.orientTurns).toBeUndefined();
    });

    it("does not detect Bash as execution phase", () => {
      tracker.onNewTurn();
      tracker.onTool("Skill", { skill: "orient" });
      tracker.onNewTurn();
      tracker.onTool("Bash", { command: "ls" });
      expect(tracker.orientTurns).toBeUndefined();
    });

    it("uses first execution tool after orient", () => {
      tracker.onNewTurn();
      tracker.onTool("Skill", { skill: "orient" });
      tracker.onNewTurn();
      tracker.onTool("Edit", { filePath: "/a" });
      tracker.onNewTurn();
      tracker.onTool("Write", { filePath: "/b" });
      expect(tracker.orientTurns).toBe(1);
    });
  });

  describe("finalize", () => {
    it("sets orientTurns if orient started but no execution tool seen", () => {
      tracker.onNewTurn();
      tracker.onTool("Skill", { skill: "orient" });
      tracker.onNewTurn();
      tracker.onNewTurn();
      tracker.finalize();
      expect(tracker.orientTurns).toBe(2);
    });

    it("does not override orientTurns if already set", () => {
      tracker.onNewTurn();
      tracker.onTool("Skill", { skill: "orient" });
      tracker.onNewTurn();
      tracker.onTool("Edit", { filePath: "/test" });
      const before = tracker.orientTurns;
      tracker.finalize();
      expect(tracker.orientTurns).toBe(before);
    });

    it("does not set orientTurns if orient never started", () => {
      tracker.onNewTurn();
      tracker.onTool("Read", { filePath: "/test" });
      tracker.finalize();
      expect(tracker.orientTurns).toBeUndefined();
    });
  });

  describe("orientTurns getter", () => {
    it("returns undefined before orient is detected", () => {
      expect(tracker.orientTurns).toBeUndefined();
    });

    it("returns undefined after orient but before execution", () => {
      tracker.onNewTurn();
      tracker.onTool("Skill", { skill: "orient" });
      expect(tracker.orientTurns).toBeUndefined();
    });

    it("returns number after execution phase detected", () => {
      tracker.onNewTurn();
      tracker.onTool("Skill", { skill: "orient" });
      tracker.onNewTurn();
      tracker.onTool("Edit", { filePath: "/test" });
      expect(tracker.orientTurns).toBe(1);
    });
  });

  describe("edge cases", () => {
    it("handles tool without input", () => {
      tracker.onNewTurn();
      tracker.onTool("Skill");
      tracker.onNewTurn();
      tracker.onTool("Edit");
      expect(tracker.orientTurns).toBeUndefined();
    });

    it("handles tool with non-string skill", () => {
      tracker.onNewTurn();
      tracker.onTool("Skill", { skill: 123 });
      tracker.onNewTurn();
      tracker.onTool("Edit", { filePath: "/test" });
      expect(tracker.orientTurns).toBeUndefined();
    });

    it("handles skill name that contains orient substring", () => {
      tracker.onNewTurn();
      tracker.onTool("Skill", { skill: "horizon-scan-orient" });
      tracker.onNewTurn();
      tracker.onTool("Edit", { filePath: "/test" });
      expect(tracker.orientTurns).toBe(1);
    });

    it("counts multiple turns during orient phase", () => {
      tracker.onNewTurn();
      tracker.onTool("Skill", { skill: "orient" });
      tracker.onNewTurn();
      tracker.onTool("Read", { filePath: "/a" });
      tracker.onNewTurn();
      tracker.onTool("Read", { filePath: "/b" });
      tracker.onNewTurn();
      tracker.onTool("Edit", { filePath: "/c" });
      expect(tracker.orientTurns).toBe(3);
    });

    it("handles execution tool in same turn as orient", () => {
      tracker.onNewTurn();
      tracker.onTool("Skill", { skill: "orient" });
      tracker.onTool("Edit", { filePath: "/test" });
      expect(tracker.orientTurns).toBe(0);
    });
  });
});
