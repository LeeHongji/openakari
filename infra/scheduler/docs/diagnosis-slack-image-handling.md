# Diagnosis: Slack Bot Image/File Attachment Handling

**Date:** 2026-03-14
**Status:** Gap confirmed — incoming file/image attachments are silently dropped

## Summary

The Slack bot does **not** handle image or file attachments sent by users. Messages containing file attachments are silently dropped at the earliest filter in the event handler. The entire pipeline — from Slack event reception through to agent prompt construction — is text-only.

## Root Cause Analysis

### 1. Event handler filter drops file_share messages

**File:** `infra/scheduler/src/slack.ts:279`

```typescript
if (message.subtype || !("text" in message)) return;
```

When a user shares a file/image in Slack, the message event has `subtype: "file_share"`. This guard clause returns immediately for **any** message with a subtype, silently discarding file shares. The same filter exists in the reference implementation (`reference-implementations/slack/slack.ts:172`).

### 2. Only text content is extracted

**File:** `infra/scheduler/src/slack.ts:280`

```typescript
const raw = message.text?.trim() ?? "";
```

Even if file_share messages passed the filter, only `message.text` is read. Slack file metadata (`message.files[].url_private_download`, `message.files[].mimetype`, etc.) is never accessed.

### 3. processMessage() accepts only strings

**File:** `infra/scheduler/src/chat/chat.ts:1821-1822`

```typescript
export async function processMessage(
  message: string,
```

The entire chat pipeline passes user input as a plain string. There is no mechanism to attach image data or file references.

### 4. ChatMessage type has no multimodal support

**File:** `infra/scheduler/src/chat/chat.ts:59-63`

```typescript
interface ChatMessage {
  role: "user" | "assistant";
  content: string;  // text-only
  timestamp: number;
}
```

### 5. Thread history ignores file attachments

**File:** `infra/scheduler/src/slack.ts:186-217`

`formatThreadMessages()` extracts only `msg.text` from thread history. Any files shared earlier in the thread are invisible to the agent.

### 6. Agent prompt is text-only

**File:** `infra/scheduler/src/agent.ts:178`

```typescript
prompt: opts.prompt,  // string
```

`spawnAgent()` passes the prompt as a plain string. The Claude Code SDK **does** support multimodal content blocks (array of `{type: "text", text: ...}` and `{type: "image", source: ...}` blocks), but the chat pipeline doesn't use this capability.

### 7. Outbound file uploads are stubbed

**File:** `infra/scheduler/src/slack.ts:157-181`

`dmFiles()`, `dmThreadFiles()`, and `channelFiles()` are all stubbed with `"File uploads not implemented"`. The reference implementation has a working `uploadFiles()` using `client.filesUploadV2()`, but this hasn't been ported to v1.

## Impact

- Users who send screenshots, images, or documents to the bot get **no response** (the message is silently ignored)
- No error message is shown — the user has no feedback that their file wasn't processed
- Multimodal capabilities of Claude (vision) are entirely unused
- Thread context loses any file-related information

## Proposed Fix

### Phase 1: Accept file_share messages and download images (minimal viable)

1. **Modify the subtype filter** (`slack.ts:279`) to allow `file_share` subtype:
   ```typescript
   const isFileShare = (message as any).subtype === "file_share";
   if (message.subtype && !isFileShare) return;
   if (!isFileShare && !("text" in message)) return;
   ```

2. **Extract file metadata** from `message.files[]`:
   ```typescript
   interface SlackFile {
     id: string;
     name: string;
     mimetype: string;
     url_private_download: string;
     size: number;
     filetype: string;  // "png", "jpg", "pdf", etc.
   }
   ```

3. **Download file content** using the bot token for authentication:
   ```typescript
   const response = await fetch(file.url_private_download, {
     headers: { Authorization: `Bearer ${env.botToken}` },
   });
   const buffer = Buffer.from(await response.arrayBuffer());
   ```

4. **For images** (mimetype starts with `image/`): convert to base64 and include as a multimodal content block in the prompt.

5. **For non-image files**: include the filename and type as text context, potentially extract text content for text-based formats.

### Phase 2: Multimodal pipeline support

1. **Extend `ChatMessage.content`** to support `string | ContentBlock[]` (matching Claude API format).

2. **Extend `processMessage()`** signature to accept optional file attachments:
   ```typescript
   interface FileAttachment {
     name: string;
     mimetype: string;
     data: Buffer;
   }

   export async function processMessage(
     message: string,
     channelId: string,
     repoDir: string,
     store: JobStore,
     callbacks: ChatCallbacks,
     opts?: ProcessMessageOpts & { files?: FileAttachment[] },
   ): Promise<...>
   ```

3. **Update `spawnAgent()`** to pass multimodal content blocks when files are present.

4. **Update `formatThreadMessages()`** to note file attachments in thread history (e.g., `[User shared image: screenshot.png]`).

### Phase 3: Port outbound file uploads from reference implementation

Port `uploadFiles()` from `reference-implementations/slack/slack-files.ts` to replace the stubbed `dmFiles()`, `dmThreadFiles()`, and `channelFiles()` functions.

### Required Slack app permissions

The bot already needs `files:read` scope to download files via `url_private_download`. Check the app manifest to ensure this scope is configured. The current manifest in the reference implementation does not list `files:read` — it would need to be added.

## Complexity Assessment

- **Phase 1**: Medium — mostly plumbing in `slack.ts`, ~100 lines of new code
- **Phase 2**: Medium — type changes propagate through chat pipeline, ~150 lines
- **Phase 3**: Low — copy from reference implementation, ~50 lines

## Files to modify

| File | Change |
|------|--------|
| `infra/scheduler/src/slack.ts` | Accept file_share, download files, pass to processMessage |
| `infra/scheduler/src/chat/chat.ts` | Accept file attachments, build multimodal prompts |
| `infra/scheduler/src/agent.ts` | Support multimodal prompt content blocks |
| `infra/scheduler/src/slack-files.ts` | Port upload implementation from reference |
| Slack app manifest | Add `files:read` scope |
