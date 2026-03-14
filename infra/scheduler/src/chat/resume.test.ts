/** Tests for resume session lifecycle: capture, reuse, expiry, and failure fallback. */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { _getConversationForTest, clearConversation } from "./chat.js";

describe("resume session lifecycle", () => {
  const channelId = "test-channel:resume-test";

  beforeEach(() => {
    clearConversation(channelId);
  });

  it("initializes with null resumeSessionId", () => {
    const conv = _getConversationForTest(channelId);
    expect(conv.resumeSessionId).toBeNull();
  });

  it("preserves resumeSessionId when conversation is active", () => {
    const conv = _getConversationForTest(channelId);
    conv.resumeSessionId = "test-session-123";
    conv.lastActivityMs = Date.now();

    // Getting the same conversation should preserve the resume ID
    const conv2 = _getConversationForTest(channelId);
    expect(conv2.resumeSessionId).toBe("test-session-123");
  });

  it("clears resumeSessionId when conversation TTL expires", () => {
    const conv = _getConversationForTest(channelId);
    conv.resumeSessionId = "test-session-123";
    // Simulate 31 minutes ago (TTL is 30 min)
    conv.lastActivityMs = Date.now() - 31 * 60 * 1000;

    // Getting the conversation after TTL should return fresh state
    const conv2 = _getConversationForTest(channelId);
    expect(conv2.resumeSessionId).toBeNull();
  });

  it("clears all state on clearConversation", () => {
    const conv = _getConversationForTest(channelId);
    conv.resumeSessionId = "test-session-123";
    conv.messages.push({ role: "user", content: "hello", timestamp: Date.now() });

    clearConversation(channelId);

    const conv2 = _getConversationForTest(channelId);
    expect(conv2.resumeSessionId).toBeNull();
    expect(conv2.messages).toHaveLength(0);
  });
});
