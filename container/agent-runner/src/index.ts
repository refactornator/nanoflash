/**
 * NanoFlash Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout.
 * Uses the Google Gemini API with an explicit tool-use loop.
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { execFile, exec } from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  GoogleGenAI,
  type Chat,
  type Content,
  type FunctionCall,
  type FunctionDeclaration,
  type Part,
  Type,
} from '@google/genai';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

// IPC constants
const IPC_DIR = '/workspace/ipc';
const IPC_INPUT_DIR = path.join(IPC_DIR, 'input');
const IPC_MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const IPC_TASKS_DIR = path.join(IPC_DIR, 'tasks');
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

const BASH_TIMEOUT_MS = 120_000; // 120 seconds
const WEB_FETCH_TIMEOUT_MS = 30_000; // 30 seconds
const WEB_FETCH_MAX_BYTES = 50 * 1024; // 50 KB
const MAX_TOOL_ROUNDS = parseInt(process.env.MAX_TOOL_ROUNDS || '25', 10);

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOFLASH_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOFLASH_OUTPUT_END---';
// Each line prefixed with this marker carries a streaming text chunk from the
// agent to the host. The host can relay these in real-time to the channel.
const STREAM_CHUNK_MARKER = '---NANOFLASH_STREAM_CHUNK---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

// ─── Path Utilities ───────────────────────────────────────────────────────

/**
 * Resolve a file path safely within the workspace.
 * Relative paths resolve relative to /workspace/group/ (or /workspace/project/ for main).
 * Absolute /workspace/* paths are allowed; anything outside is rejected.
 */
function resolvePath(filePath: string, isMain: boolean): string {
  if (path.isAbsolute(filePath)) {
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith('/workspace/')) {
      throw new Error(`Path not allowed outside workspace: ${filePath}`);
    }
    return resolved;
  }
  const base = isMain ? '/workspace/project' : '/workspace/group';
  const resolved = path.resolve(base, filePath);
  if (!resolved.startsWith('/workspace/')) {
    throw new Error(`Path traversal not allowed: ${filePath}`);
  }
  return resolved;
}

// ─── Tool Implementations ─────────────────────────────────────────────────

async function toolBrowserOpen(url: string): Promise<string> {
  return toolBash(`agent-browser open ${JSON.stringify(url)}`);
}

async function toolBrowserSnapshot(): Promise<string> {
  return toolBash('agent-browser snapshot');
}

async function toolBrowserClick(ref?: string, selector?: string): Promise<string> {
  if (ref) return toolBash(`agent-browser click --ref ${JSON.stringify(ref)}`);
  if (selector) return toolBash(`agent-browser click --selector ${JSON.stringify(selector)}`);
  return 'Error: provide ref or selector';
}

async function toolBrowserType(selector: string, text: string): Promise<string> {
  return toolBash(`agent-browser type --selector ${JSON.stringify(selector)} --text ${JSON.stringify(text)}`);
}

async function toolBrowserClose(): Promise<string> {
  return toolBash('agent-browser close');
}

async function toolBash(command: string): Promise<string> {
  return new Promise((resolve) => {
    exec(command, { cwd: '/workspace/group', timeout: BASH_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const exitCode = (error as NodeJS.ErrnoException)?.code ?? 0;
        const out = stdout.slice(0, 100_000);
        const err = stderr.slice(0, 10_000);
        resolve(`stdout:\n${out}\nstderr:\n${err}\nexit_code: ${exitCode}`);
      },
    );
  });
}

function toolReadFile(filePath: string, isMain: boolean): string {
  const resolved = resolvePath(filePath, isMain);
  if (!fs.existsSync(resolved)) throw new Error(`File not found: ${resolved}`);
  return fs.readFileSync(resolved, 'utf-8').slice(0, 200_000);
}

function toolWriteFile(filePath: string, content: string, isMain: boolean): string {
  const resolved = resolvePath(filePath, isMain);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, content, 'utf-8');
  return `Written ${content.length} bytes to ${resolved}`;
}

function toolListDirectory(dirPath: string | undefined, isMain: boolean): string {
  const resolved = resolvePath(dirPath || '.', isMain);
  if (!fs.existsSync(resolved)) throw new Error(`Directory not found: ${resolved}`);
  const entries = fs.readdirSync(resolved, { withFileTypes: true });
  const lines = entries.map((e) => {
    const type = e.isDirectory() ? 'd' : e.isSymbolicLink() ? 'l' : 'f';
    return `${type} ${e.name}`;
  });
  return lines.join('\n') || '(empty directory)';
}

function writeIpcFile(dir: string, data: object): void {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tmpPath = `${filepath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filepath);
}

function toolSendMessage(chatJid: string, text: string, groupFolder: string, replyTo?: string): string {
  const data: Record<string, string> = {
    type: 'message', chatJid, text, groupFolder, timestamp: new Date().toISOString(),
  };
  if (replyTo) data.replyTo = replyTo;
  writeIpcFile(IPC_MESSAGES_DIR, data);
  return 'Message sent.';
}

function toolReact(chatJid: string, messageId: string, emoji: string, groupFolder: string): string {
  writeIpcFile(IPC_MESSAGES_DIR, {
    type: 'reaction', chatJid, messageId, emoji, groupFolder, timestamp: new Date().toISOString(),
  });
  return `Reacted with ${emoji}.`;
}


async function toolWebFetch(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEB_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'NanoFlash/1.0' },
    });
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text') && !contentType.includes('json') && !contentType.includes('xml')) {
      return `[Binary content: ${contentType}, status: ${response.status}]`;
    }
    const buffer = await response.arrayBuffer();
    const truncated = buffer.byteLength > WEB_FETCH_MAX_BYTES;
    const slice = truncated ? buffer.slice(0, WEB_FETCH_MAX_BYTES) : buffer;
    const text = new TextDecoder().decode(slice);
    return truncated ? text + '\n[Content truncated at 50KB]' : text;
  } finally {
    clearTimeout(timer);
  }
}

function toolScheduleTask(
  prompt: string, scheduleType: string, scheduleValue: string,
  chatJid: string, groupFolder: string,
): string {
  const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  writeIpcFile(IPC_TASKS_DIR, {
    type: 'schedule_task', taskId, prompt,
    schedule_type: scheduleType, schedule_value: scheduleValue,
    context_mode: 'group', targetJid: chatJid, createdBy: groupFolder,
    timestamp: new Date().toISOString(),
  });
  return `Task ${taskId} scheduled (${scheduleType}: ${scheduleValue}).`;
}

// ─── Message Search (SQLite) ─────────────────────────────────────────────

const DB_PATH = '/workspace/project/store/messages.db';

function toolSearchMessages(chatJid: string, query?: string, limit?: number): string {
  try {
    if (!fs.existsSync(DB_PATH)) return 'Database not available (not main group or store not mounted).';
    // Dynamic import to avoid crashing if better-sqlite3 isn't available
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3');
    const db = new Database(DB_PATH, { readonly: true });
    const maxRows = Math.min(limit || 20, 50);

    let rows: Array<{ sender_name: string; content: string; timestamp: string }>;
    if (query) {
      rows = db.prepare(
        `SELECT sender_name, content, timestamp FROM messages
         WHERE chat_jid = ? AND content LIKE ?
         ORDER BY timestamp DESC LIMIT ?`
      ).all(chatJid, `%${query}%`, maxRows);
    } else {
      rows = db.prepare(
        `SELECT sender_name, content, timestamp FROM messages
         WHERE chat_jid = ?
         ORDER BY timestamp DESC LIMIT ?`
      ).all(chatJid, maxRows);
    }
    db.close();

    if (rows.length === 0) return query ? `No messages matching "${query}".` : 'No messages found.';
    return rows.map((r) => `[${r.timestamp}] ${r.sender_name}: ${r.content.slice(0, 300)}`).join('\n');
  } catch (err) {
    return `Error searching messages: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ─── Gemini Function Declarations ────────────────────────────────────────

const TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: 'bash',
    description: 'Run a shell command in /workspace/group/. Returns stdout, stderr and exit code. Timeout 120s.',
    parameters: {
      type: Type.OBJECT,
      properties: { command: { type: Type.STRING, description: 'Shell command to execute' } },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a file. Relative paths resolve to /workspace/group/ (or /workspace/project/ for main group).',
    parameters: {
      type: Type.OBJECT,
      properties: { path: { type: Type.STRING, description: 'File path' } },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file. Creates parent directories as needed.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        path: { type: Type.STRING, description: 'File path to write' },
        content: { type: Type.STRING, description: 'Content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_directory',
    description: 'List files and directories. Each line: d=directory, f=file, l=symlink.',
    parameters: {
      type: Type.OBJECT,
      properties: { path: { type: Type.STRING, description: 'Directory path (default: workspace root)' } },
    },
  },
  {
    name: 'send_message',
    description: 'Send a message to the user/group immediately while still working. Use for progress updates. Supports replying to a specific message.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        chat_jid: { type: Type.STRING, description: 'Chat JID to send to (use current chat JID)' },
        text: { type: Type.STRING, description: 'Message text' },
        reply_to: { type: Type.STRING, description: 'Message ID to reply to (from the id attribute in <message>). Creates a threaded reply.' },
      },
      required: ['chat_jid', 'text'],
    },
  },
  {
    name: 'react',
    description: 'React to a message with an emoji. Use the message id attribute from the XML. Use this to acknowledge messages, show appreciation, or react naturally.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        chat_jid: { type: Type.STRING, description: 'Chat JID (use current chat JID)' },
        message_id: { type: Type.STRING, description: 'Message ID to react to (from the id attribute in <message>)' },
        emoji: { type: Type.STRING, description: 'Emoji to react with (e.g. "👍", "❤️", "😂", "🔥", "👀")' },
      },
      required: ['chat_jid', 'message_id', 'emoji'],
    },
  },
  {
    name: 'browser_open',
    description: 'Open a URL in a headless browser. Use this for any page where web_fetch returns empty or unhelpful content — including Instagram, TikTok, Twitter, paywalled articles, and other JS-heavy sites. Always try this before saying a page is inaccessible.',
    parameters: {
      type: Type.OBJECT,
      properties: { url: { type: Type.STRING, description: 'URL to open' } },
      required: ['url'],
    },
  },
  {
    name: 'browser_snapshot',
    description: 'Get the current page content and interactive elements (text, links, buttons, refs). Call this after browser_open to read the page. Even login-gated pages (Instagram, TikTok) expose captions, usernames, hashtags, and comments.',
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: 'browser_click',
    description: 'Click an element on the current page. Use ref from browser_snapshot (preferred) or a CSS selector.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        ref: { type: Type.STRING, description: 'Element ref from browser_snapshot (e.g. "e201")' },
        selector: { type: Type.STRING, description: 'CSS selector fallback' },
      },
    },
  },
  {
    name: 'browser_type',
    description: 'Type text into an input field on the current page.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        selector: { type: Type.STRING, description: 'CSS selector for the input' },
        text: { type: Type.STRING, description: 'Text to type' },
      },
      required: ['selector', 'text'],
    },
  },
  {
    name: 'browser_close',
    description: 'Close the browser when done.',
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: 'web_fetch',
    description: 'Fetch a URL and return text content. 30s timeout. Truncated at 50KB. For JS-heavy pages use browser_open instead.',
    parameters: {
      type: Type.OBJECT,
      properties: { url: { type: Type.STRING, description: 'URL to fetch' } },
      required: ['url'],
    },
  },
  {
    name: 'schedule_task',
    description: 'Schedule a recurring or one-time task. The agent will run with the given prompt at the scheduled time.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        prompt: { type: Type.STRING, description: 'What the agent should do when the task runs' },
        schedule_type: { type: Type.STRING, description: '"cron", "interval" (ms), or "once" (local timestamp)' },
        schedule_value: { type: Type.STRING, description: 'cron: "0 9 * * *" | interval: "3600000" | once: "2026-02-01T15:30:00"' },
      },
      required: ['prompt', 'schedule_type', 'schedule_value'],
    },
  },
  {
    name: 'search_messages',
    description: 'Search the message history database. Use to find past conversations, check delivered emails (content starts with "[Email from"), or recall what was discussed. Only available to main group.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        chat_jid: { type: Type.STRING, description: 'Chat JID to search (use current chat JID for this conversation)' },
        query: { type: Type.STRING, description: 'Text to search for in message content (optional — omit to get recent messages)' },
        limit: { type: Type.NUMBER, description: 'Max results to return (default 20, max 50)' },
      },
      required: ['chat_jid'],
    },
  },
];

// ─── YouTube Search ───────────────────────────────────────────────────────

const youtubeApiKey = process.env.YOUTUBE_API_KEY || '';

async function toolYoutubeSearch(query: string, maxResults: number = 5): Promise<string> {
  if (!youtubeApiKey) return 'YouTube search not configured (YOUTUBE_API_KEY not set).';
  const n = Math.min(Math.max(1, maxResults), 10);
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=${n}&key=${youtubeApiKey}`;
  let resp: Response;
  try {
    resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    return `YouTube search request failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    return `YouTube API error ${resp.status}: ${body.slice(0, 300)}`;
  }
  const data = await resp.json() as any;
  if (!data.items?.length) return 'No results found.';
  return (data.items as any[]).map((item, i) => {
    const videoId = item.id?.videoId ?? '';
    const title = item.snippet?.title ?? '(no title)';
    const channel = item.snippet?.channelTitle ?? '';
    const published = item.snippet?.publishedAt?.slice(0, 10) ?? '';
    return `${i + 1}. ${title}\n   Channel: ${channel}  •  ${published}\n   https://www.youtube.com/watch?v=${videoId}`;
  }).join('\n\n');
}

if (youtubeApiKey) {
  TOOL_DECLARATIONS.push({
    name: 'youtube_search',
    description: 'Search YouTube for videos. Returns titles, channel names, publish dates, and working direct URLs. Use this instead of browser scraping whenever the user asks for a YouTube video.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: 'Search query, e.g. "Slayyyter Daddy AF official"' },
        max_results: { type: Type.INTEGER, description: 'Number of results to return (1–10, default 5)' },
      },
      required: ['query'],
    },
  });
  log('YouTube search tool enabled');
} else {
  log('YouTube search not available (YOUTUBE_API_KEY not set)');
}

// ─── Chrome DevTools MCP ─────────────────────────────────────────────────

let cdpMcpClient: Client | null = null;

/** Convert a JSON Schema node to the subset Gemini's FunctionDeclaration accepts. */
function jsonSchemaToGemini(schema: Record<string, unknown>): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return { type: Type.STRING };
  const typeMap: Record<string, string> = {
    string: Type.STRING, number: Type.NUMBER, integer: Type.INTEGER,
    boolean: Type.BOOLEAN, array: Type.ARRAY, object: Type.OBJECT,
  };
  const out: Record<string, unknown> = {};
  if (typeof schema.type === 'string') out.type = typeMap[schema.type] ?? Type.STRING;
  if (schema.description) out.description = schema.description;
  if (schema.enum) out.enum = schema.enum;
  if (schema.required) out.required = schema.required;
  if (schema.properties && typeof schema.properties === 'object') {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema.properties as Record<string, unknown>))
      props[k] = jsonSchemaToGemini(v as Record<string, unknown>);
    out.properties = props;
  }
  if (schema.items) out.items = jsonSchemaToGemini(schema.items as Record<string, unknown>);
  return out;
}

async function initCdpMcp(cdpUrl: string): Promise<void> {
  try {
    const transport = new StdioClientTransport({
      command: 'chrome-devtools-mcp',
      args: ['--browser-url', cdpUrl, '--no-usage-statistics'],
      stderr: 'ignore', // suppress verbose PerformanceIssue handler spam
    });
    const client = new Client({ name: 'nanoflash-agent', version: '1.0.0' });
    await client.connect(transport);
    const { tools } = await client.listTools();
    for (const tool of tools) {
      TOOL_DECLARATIONS.push({
        name: `cdp_${tool.name}`,
        description: tool.description ?? '',
        parameters: jsonSchemaToGemini(
          (tool.inputSchema ?? {}) as Record<string, unknown>
        ) as FunctionDeclaration['parameters'],
      });
    }
    cdpMcpClient = client;
    log(`Chrome DevTools MCP connected via ${cdpUrl} — ${tools.length} cdp_* tools registered`);
  } catch (err) {
    log(`Chrome DevTools MCP unavailable (${err instanceof Error ? err.message : String(err)}) — CDP tools not registered`);
  }
}

// ─── Tool Executor ────────────────────────────────────────────────────────

type ToolResult = { text: string; extraParts?: Part[] };

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  containerInput: ContainerInput,
): Promise<ToolResult> {
  const t = (text: string): ToolResult => ({ text });
  try {
    switch (name) {
      case 'bash':
        return t(await toolBash(String(args.command ?? '')));
      case 'read_file':
        return t(toolReadFile(String(args.path ?? ''), containerInput.isMain));
      case 'write_file':
        return t(toolWriteFile(String(args.path ?? ''), String(args.content ?? ''), containerInput.isMain));
      case 'list_directory':
        return t(toolListDirectory(args.path ? String(args.path) : undefined, containerInput.isMain));
      case 'send_message':
        return t(toolSendMessage(String(args.chat_jid ?? containerInput.chatJid), String(args.text ?? ''), containerInput.groupFolder, args.reply_to ? String(args.reply_to) : undefined));
      case 'react':
        return t(toolReact(String(args.chat_jid ?? containerInput.chatJid), String(args.message_id ?? ''), String(args.emoji ?? ''), containerInput.groupFolder));
      case 'browser_open':
        return t(await toolBrowserOpen(String(args.url ?? '')));
      case 'browser_snapshot':
        return t(await toolBrowserSnapshot());
      case 'browser_click':
        return t(await toolBrowserClick(args.ref ? String(args.ref) : undefined, args.selector ? String(args.selector) : undefined));
      case 'browser_type':
        return t(await toolBrowserType(String(args.selector ?? ''), String(args.text ?? '')));
      case 'browser_close':
        return t(await toolBrowserClose());
      case 'web_fetch':
        return t(await toolWebFetch(String(args.url ?? '')));
      case 'youtube_search':
        return t(await toolYoutubeSearch(String(args.query ?? ''), args.max_results ? Number(args.max_results) : 5));
      case 'schedule_task':
        return t(toolScheduleTask(String(args.prompt ?? ''), String(args.schedule_type ?? ''), String(args.schedule_value ?? ''), containerInput.chatJid, containerInput.groupFolder));
      case 'search_messages':
        return t(toolSearchMessages(String(args.chat_jid ?? containerInput.chatJid), args.query ? String(args.query) : undefined, args.limit ? Number(args.limit) : undefined));
      default:
        // Route cdp_* tools to the chrome-devtools-mcp client
        if (name.startsWith('cdp_') && cdpMcpClient) {
          const toolName = name.slice(4);
          const result = await cdpMcpClient.callTool({ name: toolName, arguments: args });
          const content = result.content as Array<{
            type: string; text?: string; data?: string; mimeType?: string;
          }>;
          // Separate text and image parts — Gemini receives both
          const text = content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n') || 'Done.';
          const extraParts: Part[] = content
            .filter((c) => c.type === 'image' && c.data)
            .map((c) => ({ inlineData: { mimeType: c.mimeType ?? 'image/png', data: c.data! } }));
          return { text, ...(extraParts.length ? { extraParts } : {}) };
        }
        return t(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return t(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── YouTube URL Detection ───────────────────────────────────────────────

const YOUTUBE_URL_RE = /https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?[^\s]*v=[\w-]+|music\.youtube\.com\/watch\?[^\s]*v=[\w-]+|youtu\.be\/[\w-]+)(?:[^\s]*)?/g;

/**
 * Normalize a YouTube URL to www.youtube.com/watch?v=ID format.
 * Gemini's fileData only accepts youtube.com, not music.youtube.com.
 */
function normalizeYoutubeUrl(url: string): string {
  // music.youtube.com → www.youtube.com
  const normalized = url.replace('music.youtube.com', 'www.youtube.com');
  // Extract video ID and rebuild clean URL to avoid extra params
  const match = normalized.match(/[?&]v=([\w-]+)/);
  if (match) return `https://www.youtube.com/watch?v=${match[1]}`;
  // youtu.be/ID
  const shortMatch = url.match(/youtu\.be\/([\w-]+)/);
  if (shortMatch) return `https://www.youtube.com/watch?v=${shortMatch[1]}`;
  return normalized;
}

/**
 * Extract YouTube URLs from text and build a multipart message.
 * Gemini natively understands YouTube videos via fileData parts,
 * so we convert URLs to fileData instead of fetching HTML.
 */
function buildMessageParts(text: string): string | Part[] {
  const rawUrls = text.match(YOUTUBE_URL_RE) || [];
  const urls = [...new Set(rawUrls.map(normalizeYoutubeUrl))];
  if (urls.length === 0) return text;

  const parts: Part[] = [];
  for (const url of urls) {
    parts.push({ fileData: { fileUri: url, mimeType: 'video/mp4' } });
  }
  // Tell the model it has the video content — without this it tries to
  // web_fetch the URL and complains it can't read transcripts.
  const hint = urls.length === 1
    ? `[The YouTube video at ${urls[0]} has been attached and you can see/hear its full content directly. Respond based on the video — do not try to fetch or scrape the URL.]`
    : `[${urls.length} YouTube videos have been attached and you can see/hear their full content directly. Respond based on the videos — do not try to fetch or scrape the URLs.]`;
  parts.push({ text: hint + '\n\n' + text });
  return parts;
}

// ─── Conversation History Persistence ────────────────────────────────────

const HISTORY_PATH = '/workspace/group/conversations/chat-history.json';
const MAX_HISTORY_TURNS = 40; // Keep last 40 entries (20 user + 20 model turns)

function hasTextOnly(entry: Content): boolean {
  return (entry.role === 'user' || entry.role === 'model') &&
    Array.isArray(entry.parts) &&
    entry.parts.every((p) => 'text' in p);
}

function loadHistory(): Content[] {
  try {
    if (!fs.existsSync(HISTORY_PATH)) return [];
    const raw = fs.readFileSync(HISTORY_PATH, 'utf-8');
    const history = JSON.parse(raw) as Content[];
    if (!Array.isArray(history)) return [];
    let textOnly = history.filter(hasTextOnly);
    // Gemini requires history to start with 'user' and alternate roles
    while (textOnly.length > 0 && textOnly[0].role !== 'user') {
      textOnly = textOnly.slice(1);
    }
    // Ensure alternating user/model pairs
    const valid: Content[] = [];
    for (const entry of textOnly) {
      if (valid.length === 0 && entry.role !== 'user') continue;
      const lastRole = valid.length > 0 ? valid[valid.length - 1].role : null;
      if (lastRole === entry.role) continue; // skip consecutive same-role
      valid.push(entry);
    }
    // Must end on 'model' so the next sendMessage is 'user'
    if (valid.length > 0 && valid[valid.length - 1].role === 'user') {
      valid.pop();
    }
    const trimmed = valid.slice(-MAX_HISTORY_TURNS);
    log(`Loaded ${trimmed.length} history turns (of ${history.length} total)`);
    return trimmed;
  } catch (err) {
    log(`Failed to load history: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

async function saveHistory(chat: Chat): Promise<void> {
  try {
    const history = chat.getHistory();
    const textOnly = history.filter(hasTextOnly);
    const trimmed = textOnly.slice(-MAX_HISTORY_TURNS);
    fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(trimmed, null, 2));
  } catch (err) {
    log(`Failed to save history: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Context Caching ─────────────────────────────────────────────────────

import crypto from 'crypto';

const CACHE_STATE_PATH = '/workspace/group/conversations/cache-state.json';

interface CacheState {
  cacheId: string;
  instructionHash: string;
  toolsHash: string;
  model: string;
  expiresAt: string; // ISO timestamp
}

function hashString(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function loadCacheState(): CacheState | null {
  try {
    if (!fs.existsSync(CACHE_STATE_PATH)) return null;
    return JSON.parse(fs.readFileSync(CACHE_STATE_PATH, 'utf-8')) as CacheState;
  } catch { return null; }
}

function saveCacheState(state: CacheState): void {
  fs.mkdirSync(path.dirname(CACHE_STATE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_STATE_PATH, JSON.stringify(state, null, 2));
}

/**
 * Get a valid cached content ID for the given system instruction and tools,
 * or create one. The Gemini API requires that tools be baked into the cache at
 * creation time — they must NOT be passed again in the chat config.
 * Returns null if caching is unavailable (instruction too short, API error, etc.).
 * Falls back gracefully — never throws.
 */
async function getOrCreateCache(
  ai: GoogleGenAI, model: string,
  systemInstruction: string, tools: object[], ttlSeconds: number,
): Promise<string | null> {
  const instructionHash = hashString(systemInstruction);
  const toolsHash = hashString(JSON.stringify(tools));
  const cached = loadCacheState();

  // Reuse existing cache if both hashes match and it won't expire within 5 minutes
  if (cached && cached.instructionHash === instructionHash && cached.toolsHash === toolsHash && cached.model === model) {
    const expiresAt = new Date(cached.expiresAt).getTime();
    if (Date.now() < expiresAt - 5 * 60 * 1000) {
      log(`Using existing cache: ${cached.cacheId}`);
      return cached.cacheId;
    }
    log('Cache expiring soon, refreshing...');
  }

  // Rough token estimate: ~4 chars per token. Flash minimum: 1024 tokens.
  if (systemInstruction.length / 4 < 1024) {
    log(`System instruction too short for caching (${systemInstruction.length} chars), skipping`);
    return null;
  }

  try {
    // IMPORTANT: tools must be included in the cache, not in the chat config.
    // Passing tools in both places causes a 400 INVALID_ARGUMENT error.
    const cache = await ai.caches.create({
      model,
      config: { systemInstruction, tools, ttl: `${ttlSeconds}s` },
    });
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const cacheId = cache.name ?? '';
    if (!cacheId) { log('Cache created but returned no name, skipping'); return null; }
    saveCacheState({ cacheId, instructionHash, toolsHash, model, expiresAt });
    log(`Created cache: ${cacheId}`);
    return cacheId;
  } catch (err) {
    log(`Cache creation failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ─── Gemini Query ─────────────────────────────────────────────────────────

/**
 * Consume one streaming response turn. Writes STREAM_CHUNK markers to stdout
 * for each text chunk so the host can relay them to the channel in real-time.
 * Returns the accumulated full text and any function calls from this turn.
 */
async function consumeStream(
  stream: AsyncGenerator<import('@google/genai').GenerateContentResponse>,
): Promise<{ text: string; functionCalls: FunctionCall[] }> {
  let text = '';
  const functionCalls: FunctionCall[] = [];
  for await (const chunk of stream) {
    // Iterate raw parts instead of using chunk.text, which aggregates thinking
    // tokens (thought: true) together with response text. Gemini 2.5 Flash
    // emits thinking tokens as separate parts — we stream only the final response.
    const parts = chunk.candidates?.[0]?.content?.parts ?? [];
    for (const part of parts) {
      if ((part as { thought?: boolean }).thought) continue;
      if (part.text) {
        text += part.text;
        process.stdout.write(`${STREAM_CHUNK_MARKER}${JSON.stringify({ text: part.text })}\n`);
      }
    }
    if (chunk.functionCalls?.length) {
      functionCalls.push(...chunk.functionCalls);
    }
  }
  return { text, functionCalls };
}

/**
 * Run a user prompt through Gemini with the streaming tool loop.
 * Streams text tokens to stdout as they arrive; returns the full response text.
 */
async function runGeminiQuery(
  prompt: string,
  containerInput: ContainerInput,
  chat: Chat,
): Promise<string> {
  log(`Running query (${prompt.length} chars)...`);
  const message = buildMessageParts(prompt);
  if (message !== prompt) {
    const urls = prompt.match(YOUTUBE_URL_RE) || [];
    log(`Detected ${urls.length} YouTube URL(s), sending as fileData`);
  }

  const firstStream = await chat.sendMessageStream({ message });
  let { text: fullText, functionCalls } = await consumeStream(firstStream);
  let toolRounds = 0;

  while (toolRounds < MAX_TOOL_ROUNDS && functionCalls.length > 0) {
    toolRounds++;
    log(`Tool round ${toolRounds}: ${functionCalls.map((c) => c.name ?? '?').join(', ')}`);

    const functionResponses: Part[] = (
      await Promise.all(
        functionCalls.map(async (call) => {
          const toolName = call.name ?? '';
          const result = await executeTool(toolName, call.args ?? {}, containerInput);
          log(`  ${toolName} → ${result.text.slice(0, 120)}`);
          const fnPart: Part = { functionResponse: { name: toolName, response: { result: result.text } } };
          // Append any image parts (e.g. cdp_take_screenshot) so Gemini sees the visual
          return result.extraParts ? [fnPart, ...result.extraParts] : [fnPart];
        }),
      )
    ).flat();

    const toolStream = await chat.sendMessageStream({ message: functionResponses });
    const turn = await consumeStream(toolStream);
    fullText += turn.text;
    functionCalls = turn.functionCalls;
  }

  if (toolRounds >= MAX_TOOL_ROUNDS) {
    log(`Warning: reached MAX_TOOL_ROUNDS (${MAX_TOOL_ROUNDS}), returning current response`);
  }

  log(`Query complete: ${fullText.length} chars, ${toolRounds} tool rounds`);
  return fullText;
}

// ─── IPC Helpers ──────────────────────────────────────────────────────────

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR).filter((f) => f.endsWith('.json')).sort();
    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) messages.push(data.text);
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) { resolve(null); return; }
      const messages = drainIpcInput();
      if (messages.length > 0) { resolve(messages.join('\n')); return; }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

// ─── Script Runner ────────────────────────────────────────────────────────

interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
}

const SCRIPT_TIMEOUT_MS = 30_000;

async function runScript(script: string): Promise<ScriptResult | null> {
  const scriptPath = '/tmp/task-script.sh';
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  return new Promise((resolve) => {
    execFile('bash', [scriptPath], { timeout: SCRIPT_TIMEOUT_MS, maxBuffer: 1024 * 1024, env: process.env },
      (error, stdout, stderr) => {
        if (stderr) log(`Script stderr: ${stderr.slice(0, 500)}`);
        if (error) { log(`Script error: ${error.message}`); return resolve(null); }
        const lines = stdout.trim().split('\n');
        const lastLine = lines[lines.length - 1];
        if (!lastLine) { log('Script produced no output'); return resolve(null); }
        try {
          const result = JSON.parse(lastLine);
          if (typeof result.wakeAgent !== 'boolean') {
            log(`Script output missing wakeAgent boolean: ${lastLine.slice(0, 200)}`);
            return resolve(null);
          }
          resolve(result as ScriptResult);
        } catch {
          log(`Script output is not valid JSON: ${lastLine.slice(0, 200)}`);
          resolve(null);
        }
      },
    );
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({ status: 'error', result: null, error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}` });
    process.exit(1);
  }

  const apiKey = process.env.GEMINI_API_KEY || '';
  if (!apiKey) {
    writeOutput({ status: 'error', result: null, error: 'GEMINI_API_KEY is not set in the container environment' });
    process.exit(1);
  }
  const primaryModel = process.env.GEMINI_PRIMARY_MODEL || 'gemini-2.5-flash';

  // Build system instruction from CLAUDE.md files
  const systemParts: string[] = [];
  const groupClaudeMdPath = '/workspace/group/CLAUDE.md';
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  if (fs.existsSync(groupClaudeMdPath)) {
    systemParts.push(fs.readFileSync(groupClaudeMdPath, 'utf-8'));
  }
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    systemParts.push(fs.readFileSync(globalClaudeMdPath, 'utf-8'));
  }
  const systemInstruction = systemParts.join('\n\n---\n\n') ||
    `You are ${containerInput.assistantName || 'Sergey'}, a personal assistant. Your working directory is /workspace/group/.`;

  const ai = new GoogleGenAI({ apiKey });

  // Thinking mode: -1 = dynamic (model decides), 0 = disabled, >0 = fixed budget
  const thinkingBudget = parseInt(process.env.GEMINI_THINKING_BUDGET || '-1', 10);
  const supportsThinking = primaryModel.includes('2.5-flash') || primaryModel.includes('2.5-pro');
  const thinkingConfigEntry = supportsThinking && thinkingBudget !== 0 ? { thinkingConfig: { thinkingBudget } } : {};

  // Context caching: cache the system instruction server-side to reduce
  // per-request token cost for groups with large CLAUDE.md files.
  // Falls back silently if the instruction is too short or the API rejects it.
  const cacheTtlSeconds = parseInt(process.env.GEMINI_CACHE_TTL_SECONDS || '3600', 10);
  // Connect to host Chrome via chrome-devtools-mcp when CHROME_CDP_URL is set.
  // Must run before toolsForCache so discovered cdp_* tools are included.
  const chromeCdpUrl = process.env.CHROME_CDP_URL || '';
  if (chromeCdpUrl) {
    await initCdpMcp(chromeCdpUrl);
  } else {
    log('Chrome DevTools MCP not configured (ENABLE_CHROME_MCP not set) — using headless agent-browser');
  }

  // googleSearch (built-in grounding) cannot be combined with functionDeclarations
  // inside a cached context — the Gemini API rejects the combination with 400.
  // We cache with function calling only; grounding is added on the non-cached path.
  const toolsForCache = [{ functionDeclarations: TOOL_DECLARATIONS }];
  const toolsWithGrounding = [{ googleSearch: {} }, { functionDeclarations: TOOL_DECLARATIONS }];
  const cacheId = await getOrCreateCache(ai, primaryModel, systemInstruction, toolsForCache, cacheTtlSeconds);

  // Load conversation history from previous container runs so the agent
  // retains context across restarts. History is saved after each query.
  const previousHistory = loadHistory();

  // IMPORTANT: when cachedContent is used, do NOT also pass systemInstruction or
  // tools — the API returns 400. Both are already baked into the cache.
  // Trade-off: googleSearch grounding is unavailable when caching is active.
  const buildChatConfig = (id: string | null) =>
    id
      ? { cachedContent: id, ...thinkingConfigEntry }
      : { systemInstruction, tools: toolsWithGrounding, ...thinkingConfigEntry };

  // Helper: return a fresh chat using the most up-to-date cache, preserving history.
  // Call this before each follow-up query so a mid-session cache expiry never
  // causes a 403 "CachedContent not found" crash — we just recreate and continue.
  const refreshChat = async (history: any[]) => {
    const freshCacheId = await getOrCreateCache(ai, primaryModel, systemInstruction, toolsForCache, cacheTtlSeconds);
    return ai.chats.create({ model: primaryModel, config: buildChatConfig(freshCacheId), history });
  };

  let chat = ai.chats.create({
    model: primaryModel,
    config: buildChatConfig(cacheId),
    history: previousHistory,
  });

  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  // Clean up stale _close sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - This message was sent automatically, not by the user directly.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Script phase: run script before waking agent (scheduled tasks only)
  if (containerInput.script && containerInput.isScheduledTask) {
    log('Running task script...');
    const scriptResult = await runScript(containerInput.script);
    if (!scriptResult || !scriptResult.wakeAgent) {
      log(`Script decided not to wake agent: ${scriptResult ? 'wakeAgent=false' : 'script error'}`);
      writeOutput({ status: 'success', result: null });
      return;
    }
    log('Script wakeAgent=true, enriching prompt with script data');
    prompt = `[SCHEDULED TASK]\n\nScript output:\n${JSON.stringify(scriptResult.data, null, 2)}\n\nInstructions:\n${containerInput.prompt}`;
  }

  // Query loop: run Gemini query → emit output → save history → wait for IPC → repeat
  try {
    while (true) {
      const text = await runGeminiQuery(prompt, containerInput, chat);
      writeOutput({ status: 'success', result: text });
      await saveHistory(chat);

      log('Query ended, waiting for next IPC message...');
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got follow-up message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;

      // Refresh the chat session before each follow-up query. This is a no-op
      // when the cache is still valid, but recreates it if it has expired —
      // preventing the 403 "CachedContent not found" crash mid-session.
      chat = await refreshChat(chat.getHistory());
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({ status: 'error', result: null, error: errorMessage });
    process.exit(1);
  }
}

main();
