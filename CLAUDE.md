# NanoFlash

Personal Gemini agent harness. See [README.md](README.md) for philosophy and setup.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to a Gemini agent loop running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Architecture

```
User message → Channel (Telegram/WhatsApp/etc.)
  → SQLite (store message)
  → Polling loop (src/index.ts, every 2s)
  → container-runner.ts spawns Apple Container / Docker
    → agent-runner (container/agent-runner/src/index.ts)
      → Gemini API with tool loop
      → stdout: NANOFLASH_OUTPUT_START/END markers
  → Host parses output, sends response via channel
  → IPC files for side-effects (messages, reactions, tasks)
```

**Two-process boundary:** The host process (`src/`) manages channels, DB, IPC, and container lifecycle. The agent process (`container/agent-runner/`) runs inside a Linux container with only mounted directories visible. These communicate via stdin/stdout (initial prompt + output markers) and filesystem IPC (`/workspace/ipc/`).

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/container-runner.ts` | Spawns agent containers, builds mounts and env vars, parses output markers |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher: processes message/reaction/task files from containers |
| `src/router.ts` | Formats messages as XML for the agent, strips `<internal>` tags on output |
| `src/config.ts` | All configuration: trigger pattern, paths, intervals, Gemini models |
| `src/gemini-media.ts` | Host-side media analysis — images inline, video/audio via Gemini File API (up to 2 GB) |
| `src/task-scheduler.ts` | Runs scheduled tasks on cron/interval/once schedules |
| `src/db.ts` | SQLite operations (messages, sessions, groups, tasks) |
| `src/types.ts` | Channel interface, RegisteredGroup, NewMessage, etc. |
| `groups/{name}/CLAUDE.md` | Per-group system instruction (loaded as Gemini systemInstruction) |
| `container/agent-runner/src/index.ts` | **The agent** — Gemini tool loop, all tool implementations |

## How to Add a Tool to the Agent

Tools are defined and executed in `container/agent-runner/src/index.ts`. Three steps:

1. **Add the implementation function:**
```typescript
function toolMyThing(arg: string): string {
  // Do work, return result string
  return 'Done.';
}
```

2. **Add the tool declaration** to `TOOL_DECLARATIONS` array:
```typescript
{
  name: 'my_thing',
  description: 'What this tool does.',
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      arg: { type: SchemaType.STRING, description: 'The argument' },
    },
    required: ['arg'],
  },
},
```

3. **Add the executor case** in the `executeTool` switch:
```typescript
case 'my_thing':
  return toolMyThing(String(args.arg ?? ''));
```

For tools that need **IPC side-effects** (sending messages, reactions, scheduling tasks), write a JSON file to the IPC directory using `writeIpcFile()`. The host process picks these up in `src/ipc.ts`.

### Conditional tools

Tools can be registered conditionally based on environment variables. Check for credentials at startup and push declarations to `TOOL_DECLARATIONS` only when available. See the calendar tools pattern for an example.

## How to Add a Channel

Channels implement the `Channel` interface from `src/types.ts`:

```typescript
interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string, replyToMessageId?: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  sendReaction?(jid: string, messageId: string, emoji: string): Promise<void>;
  syncGroups?(force: boolean): Promise<void>;
}
```

Steps:
1. Create `src/channels/mychanel.ts` implementing `Channel`
2. Call `registerChannel('mychannel', factory)` at module level — the factory receives `ChannelOpts` (onMessage, onChatMetadata, registeredGroups) and returns a Channel instance or null if credentials are missing
3. Add `import './mychannel.js'` to `src/channels/index.ts`

The channel is responsible for:
- Connecting to the platform API
- Calling `opts.onMessage(chatJid, msg)` for each inbound message
- Calling `opts.onChatMetadata(jid, timestamp, name, channelName, isGroup)` for chat discovery
- Implementing `sendMessage` for outbound delivery
- Using a JID prefix to namespace its chats (e.g. `tg:123`, `gmail:threadId`, `dc:456`)

## How Credentials Flow to Containers

```
.env (host) → src/config.ts reads values
  → src/container-runner.ts passes as -e env vars to container
  → container/agent-runner/src/index.ts reads process.env
```

To pass a new credential to containers:
1. Read it in `src/config.ts` or directly in `src/container-runner.ts`
2. Add an `args.push('-e', ...)` line in `buildContainerArgs()` in `container-runner.ts`
3. Read it from `process.env` in the agent-runner

## IPC Protocol

Containers communicate side-effects via JSON files written to `/workspace/ipc/`:

| Directory | Purpose |
|-----------|---------|
| `messages/` | Outbound messages and reactions from the agent |
| `tasks/` | Task scheduling, group registration, and other control operations |
| `input/` | Follow-up messages piped to the running container |
| `input/_close` | Sentinel file — signals the container to exit |

Message IPC file format:
```json
{"type": "message", "chatJid": "tg:123", "text": "Hello", "replyTo": "456", "groupFolder": "telegram_main"}
{"type": "reaction", "chatJid": "tg:123", "messageId": "789", "emoji": "👍", "groupFolder": "telegram_main"}
```

The host-side handler is in `src/ipc.ts`. New IPC types need a handler case there and wiring in `src/index.ts` where `startIpcWatcher()` is called.

## Message Format (Agent Input)

Messages are formatted as XML by `src/router.ts`:
```xml
<context timezone="America/Los_Angeles" />
<messages>
<message sender="Liam" time="Apr 4, 2026, 10:30 PM" id="123">Hello</message>
<message sender="Liam" time="Apr 4, 2026, 10:31 PM" id="124" reply_to="120">
  <quoted_message from="Sergey">Previous reply</quoted_message>This is a reply</message>
</messages>
```

The `id` attribute is the platform message ID — tools like `react` and `send_message` (with `reply_to`) reference these.

## Conversation History

The agent-runner persists chat history to `/workspace/group/conversations/chat-history.json` after each query. On startup, it loads previous history and passes it to `startChat({ history })`. Only user/model text turns are saved (tool calls are session-specific). Capped at 40 turns.

## YouTube

### Video understanding
YouTube URLs in prompts are detected by regex, converted to Gemini `fileData` parts, and sent alongside the text. This gives the model native video understanding without tool calls. `music.youtube.com` URLs are normalized to `www.youtube.com`. A hint is injected telling the model it can see the video directly.

### YouTube search tool
The `youtube_search` tool in `container/agent-runner/src/index.ts` queries the YouTube Data API v3 and returns real video titles, channels, publish dates, and working URLs. It is registered conditionally — only when `YOUTUBE_API_KEY` is present in the container environment. To enable it:
1. Enable **YouTube Data API v3** in Google Cloud Console
2. Create an API key (no OAuth required)
3. Add `YOUTUBE_API_KEY=your-key` to `.env`
4. The key is passed to containers automatically via `src/container-runner.ts`

Without the key the tool is silently absent and the agent falls back to browser scraping.

## Secrets / Credentials

`GEMINI_API_KEY` is read from `.env` and injected directly into the container as an environment variable. Keep `.env` gitignored. To rotate: update `.env` and restart the service.

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
npx vitest run       # Run tests
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoflash.plist
launchctl unload ~/Library/LaunchAgents/com.nanoflash.plist
launchctl kickstart -k gui/$(id -u)/com.nanoflash  # restart

# Linux (systemd)
systemctl --user start nanoflash
systemctl --user stop nanoflash
systemctl --user restart nanoflash
```

After modifying `container/agent-runner/src/`, the cached copy in `data/sessions/{group}/agent-runner-src/` must be refreshed. The host auto-copies when the source file mtime is newer, so just restart the service. For the container image itself (`container/Dockerfile`), rebuild with `./container/build.sh`.

## Complete Deploy Sequence

After ANY change to source files, follow this exact order:

```bash
npm run build          # 1. Compile host TypeScript (src/ changes)
./container/build.sh   # 2. Rebuild container image (container/agent-runner/src/ changes)
# then restart the service
```

Skipping step 1 leaves stale `dist/` JS running on the host. Skipping step 2 leaves stale agent code in the container image.

## Log Files

| File | What's in it |
|------|-------------|
| `logs/nanoflash.log` | Host process: channel connections, message routing, agent dispatch, IPC |
| `logs/nanoflash.error.log` | Errors + agent container stderr/stdout for every completed run |
| `groups/{name}/logs/container-*.log` | Per-run agent log (full stdout+stderr for that container invocation) |

**Diagnosis workflow:** Check `nanoflash.error.log` first — it captures both the host error and the agent's stderr in the same entry. Look for the `logFile` field in each error block to find the full per-run container log.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, reset the builder:

**Apple Container (macOS):**
```bash
container builder stop && container builder delete --force && container builder start
./container/build.sh
```

**Docker:**
```bash
docker builder prune --all --force
./container/build.sh
```

## Gemini API Constraints (Context Caching)

The Gemini API has non-obvious rules around context caching that cause `400 INVALID_ARGUMENT` errors:

1. **`cachedContent` is mutually exclusive with `systemInstruction` and `tools` in the chat config.**
   Everything must be baked into the cache at creation time via `ai.caches.create()` — do not pass them again in `ai.chats.create()`.

2. **`googleSearch` (built-in grounding) and `functionDeclarations` cannot coexist in a cached context.**
   Solution: cache with `functionDeclarations` only; `googleSearch` grounding is active only when caching is not used.

3. **Stale `cache-state.json` causes repeated 400 failures.** Delete it to force cache recreation:
   ```bash
   rm groups/{name}/conversations/cache-state.json
   ```

Error message signatures:
- `CachedContent can not be used with GenerateContent request setting system_instruction, tools or tool_config` → tools passed in both cache and chat config
- `Built-in tools ({google_search}) and Function Calling cannot be combined` → `googleSearch` + `functionDeclarations` in same cached context tools array
