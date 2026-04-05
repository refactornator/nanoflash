# NanoFlash

A Gemini-native personal agent harness. Same architecture as [NanoClaw](https://github.com/qwibitai/nanoclaw) (channels, containers, IPC, SQLite, polling loop) — Gemini replaces Claude Code as the agent inside the container.

---

## Why NanoFlash

NanoFlash is a fork of [NanoClaw](https://github.com/qwibitai/nanoclaw) with one fundamental change: **Gemini runs inside the container instead of Claude Code**.

Everything that makes NanoClaw good carries over: one process, a handful of files, agents in isolated Linux containers, filesystem-level security. The only difference is you bring a `GEMINI_API_KEY` instead of a Claude Code subscription.

## Quick Start

```bash
gh repo fork <your-username>/nanoflash --clone
cd nanoflash
```

1. Add your Gemini API key to `.env`:
   ```
   GEMINI_API_KEY=your-key-here
   ```
   Get a free key at [aistudio.google.com](https://aistudio.google.com).

2. Install deps and build:
   ```bash
   npm install
   npm run build
   ./container/build.sh
   ```

3. Run `/setup` (using Claude Code) or follow the manual setup in `setup/` to connect a channel and start the service.

## Philosophy

**Small enough to understand.** One process, a few source files, no microservices. If you want to understand the full NanoFlash codebase, read it in an afternoon.

**Secure by isolation.** Agents run in Linux containers (Apple Container on macOS, or Docker). They can only see what's explicitly mounted. Bash access is safe because commands run inside the container, not on your host.

**Built for the individual user.** Fork it, customize it, make it yours. The codebase is small enough that it's safe to modify.

**Gemini-native.** Uses `gemini-2.5-flash` by default for both the agent loop and media analysis. Models are configurable via env vars.

## What It Supports

- **Multi-channel messaging** — WhatsApp, Telegram, Discord, Slack, Gmail. Add channels with skills like `/add-whatsapp` or `/add-telegram`.
- **Isolated group context** — Each group has its own `CLAUDE.md` memory, isolated filesystem, and container sandbox.
- **Main channel** — Your private channel (self-chat) for admin control; every group is completely isolated.
- **Scheduled tasks** — Recurring jobs that run the Gemini agent and can message you back.
- **Web access** — Fetch content from URLs (built-in `web_fetch` tool).
- **Container isolation** — Agents are sandboxed in Docker or Apple Container.
- **Media analysis** — Host-side image, video, and voice transcription via Gemini Flash.
- **Optional integrations** — Add Gmail, voice transcription, and more via skills.

## Usage

Talk to your assistant with the trigger word (default: `@Sergey`):

```
@Sergey send an overview of the sales pipeline every weekday morning at 9am
@Sergey review the git history for the past week each Friday and update the README if there's drift
@Sergey every Monday at 8am, compile news on AI developments from Hacker News and message me a briefing
```

From the main channel (your self-chat), you can manage groups and tasks:
```
@Sergey list all scheduled tasks across groups
@Sergey pause the Monday briefing task
@Sergey join the Family Chat group
```

## Requirements

- macOS, Linux, or Windows (via WSL2)
- Node.js 20+
- Gemini API key ([get one free](https://aistudio.google.com))
- [Apple Container](https://github.com/apple/container) (macOS) or [Docker](https://docker.com/products/docker-desktop) (macOS/Linux)
- Claude Code (optional — used for setup skills and customization)

## Architecture

```
Channels --> SQLite --> Polling loop --> Container (Gemini agent loop) --> Response
```

Single Node.js process. Channels self-register at startup. Agents execute in isolated Linux containers. Only mounted directories are accessible. Per-group message queue. IPC via filesystem. The Gemini agent runs a tool loop inside the container with bash, file I/O, web fetch, and IPC tools.

Key files:
- `src/index.ts` — Orchestrator: state, message loop, agent invocation
- `src/channels/registry.ts` — Channel registry (self-registration at startup)
- `src/ipc.ts` — IPC watcher and task processing
- `src/router.ts` — Message formatting and outbound routing
- `src/gemini-media.ts` — Host-side image/video/audio analysis via Gemini Flash
- `src/container-runner.ts` — Spawns agent containers with mounts
- `src/task-scheduler.ts` — Runs scheduled tasks
- `src/db.ts` — SQLite operations
- `container/agent-runner/src/index.ts` — Gemini tool loop (runs inside container)
- `groups/*/CLAUDE.md` — Per-group memory and instructions

## Configuration

`.env` file at the project root:

```bash
GEMINI_API_KEY=your-key-here
GEMINI_PRIMARY_MODEL=gemini-2.5-flash                     # optional, this is the default
GEMINI_FAST_MODEL=gemini-2.5-flash                        # optional, used for media analysis
ASSISTANT_NAME=Sergey                                     # trigger word / agent name
TZ=America/New_York                                       # your timezone
```

Credentials are read from `.env` and passed directly to containers as environment variables. No proxy or vault needed — Gemini API keys are free-tier accessible and easy to rotate.

## FAQ

**Why pass the API key directly to the container?**

Gemini API keys are free-tier accessible and easy to rotate. The key is passed as an environment variable to the container — simpler than running a local proxy. If you want stronger isolation, replace this with a proxy that injects the key at request time (see `src/container-runner.ts`).

**Why Docker?**

Cross-platform support (macOS, Linux, Windows via WSL2) and a mature ecosystem. On macOS you can switch to Apple Container via `/convert-to-apple-container` for a lighter native runtime.

**Is this secure?**

Agents run in containers, not behind application-level permission checks. They can only access explicitly mounted directories. The only thing that isn't sandboxed is the `GEMINI_API_KEY` env var — keep it in `.env` (gitignored).

**Can I change the model?**

Yes. Set `GEMINI_PRIMARY_MODEL` in `.env` to any model in the `generativelanguage.googleapis.com` endpoint. Fast model for media is set separately via `GEMINI_FAST_MODEL`.

**How do I debug issues?**

Run `/debug` inside Claude Code, or check the logs in `groups/{name}/logs/`.

## License

MIT
