# NanoFlash

Personal Gemini agent harness. See [README.md](README.md) for philosophy and setup.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to a Gemini agent loop running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals, Gemini config |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/gemini-media.ts` | Host-side image/video/audio analysis via Gemini Flash |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/agent-runner/src/index.ts` | Gemini tool loop (runs inside containers) |

## Secrets / Credentials

`GEMINI_API_KEY` is read from `.env` and injected directly into the container as an environment variable. Keep `.env` gitignored. To rotate: update `.env` and restart the service.

## Skills

Four types of skills exist in NanoFlash. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full taxonomy and guidelines.

- **Feature skills** — merge a `skill/*` branch to add capabilities (e.g. `/add-telegram`, `/add-slack`)
- **Utility skills** — ship code files alongside SKILL.md (e.g. `/claw`)
- **Operational skills** — instruction-only workflows, always on `main` (e.g. `/setup`, `/debug`)
- **Container skills** — loaded inside agent containers at runtime (`container/skills/`)

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
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

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is a separate skill, not bundled in core. Run `/add-whatsapp` to install it.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
