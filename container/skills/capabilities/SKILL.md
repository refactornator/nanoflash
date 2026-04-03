---
name: capabilities
description: Show what this NanoFlash instance can do — built-in tools, optional tools, and system info. Read-only. Use when the user asks what the bot can do or runs /capabilities.
---

# /capabilities — System Capabilities Report

Generate a structured read-only report of what this NanoFlash instance can do.

**Main-channel check:** Only the main channel has `/workspace/project` mounted. Run:

```bash
test -d /workspace/project && echo "MAIN" || echo "NOT_MAIN"
```

If `NOT_MAIN`, respond with:
> This command is available in your main chat only. Send `/capabilities` there to see what I can do.

Then stop — do not generate the report.

## How to gather the information

Run these commands and compile the results into the report format below.

### 1. Built-in Gemini agent tools

NanoFlash always has these tools available (implemented as Gemini function declarations):
- `bash` — run shell commands in your sandbox (timeout 120s)
- `read_file` — read files from the workspace
- `write_file` — write files to the workspace
- `list_directory` — list directory contents
- `send_message` — send a message to the user immediately while still working
- `web_fetch` — fetch a URL and return the content (timeout 30s, 50KB cap)
- `schedule_task` — schedule a recurring or one-time task

### 2. Optional container tools (bash executables)

Check what optional tools are installed:

```bash
which agent-browser 2>/dev/null && echo "agent-browser: available" || echo "agent-browser: not found"
```

### 3. Model info

```bash
echo "Primary model: ${GEMINI_PRIMARY_MODEL:-gemini-2.5-pro-latest}"
echo "Fast model: ${GEMINI_FAST_MODEL:-gemini-2.0-flash}"
```

### 4. Group info

```bash
test -f /workspace/group/CLAUDE.md && echo "Group memory: yes" || echo "Group memory: no"
test -d /workspace/extra && echo "Extra mounts: $(ls /workspace/extra/ 2>/dev/null | wc -l | tr -d ' ')" || echo "Extra mounts: none"
```

## Report format

Present the report as a clean, readable message. Example:

```
📋 *NanoFlash Capabilities*

*Agent:* Gemini (gemini-2.5-pro-latest)

*Built-in Tools:*
• bash — run shell commands in sandbox
• read_file / write_file / list_directory — file I/O
• send_message — send progress updates
• web_fetch — fetch URLs (50KB cap)
• schedule_task — schedule recurring or one-time tasks

*Optional Tools:*
• agent-browser: ✓ (or ✗)

*System:*
• Group memory: yes/no
• Extra mounts: N directories
• Main channel: yes/no
```

Adapt the output based on what you actually find — don't list things that aren't available.

**See also:** `/status` for a quick health check of session, workspace, and tasks.
