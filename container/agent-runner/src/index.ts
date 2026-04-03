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
import {
  GoogleGenerativeAI,
  type Content,
  type FunctionDeclaration,
  type Tool,
  type GenerateContentResult,
  SchemaType,
} from '@google/generative-ai';

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

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

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

function toolSendMessage(chatJid: string, text: string, groupFolder: string): string {
  writeIpcFile(IPC_MESSAGES_DIR, {
    type: 'message', chatJid, text, groupFolder, timestamp: new Date().toISOString(),
  });
  return 'Message sent.';
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

// ─── Gemini Function Declarations ────────────────────────────────────────

const TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: 'bash',
    description: 'Run a shell command in /workspace/group/. Returns stdout, stderr and exit code. Timeout 120s.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: { command: { type: SchemaType.STRING, description: 'Shell command to execute' } },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a file. Relative paths resolve to /workspace/group/ (or /workspace/project/ for main group).',
    parameters: {
      type: SchemaType.OBJECT,
      properties: { path: { type: SchemaType.STRING, description: 'File path' } },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file. Creates parent directories as needed.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        path: { type: SchemaType.STRING, description: 'File path to write' },
        content: { type: SchemaType.STRING, description: 'Content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_directory',
    description: 'List files and directories. Each line: d=directory, f=file, l=symlink.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: { path: { type: SchemaType.STRING, description: 'Directory path (default: workspace root)' } },
    },
  },
  {
    name: 'send_message',
    description: 'Send a message to the user/group immediately while still working. Use for progress updates.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        chat_jid: { type: SchemaType.STRING, description: 'Chat JID to send to (use current chat JID)' },
        text: { type: SchemaType.STRING, description: 'Message text' },
      },
      required: ['chat_jid', 'text'],
    },
  },
  {
    name: 'web_fetch',
    description: 'Fetch a URL and return text content. 30s timeout. Truncated at 50KB.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: { url: { type: SchemaType.STRING, description: 'URL to fetch' } },
      required: ['url'],
    },
  },
  {
    name: 'schedule_task',
    description: 'Schedule a recurring or one-time task. The agent will run with the given prompt at the scheduled time.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        prompt: { type: SchemaType.STRING, description: 'What the agent should do when the task runs' },
        schedule_type: { type: SchemaType.STRING, description: '"cron", "interval" (ms), or "once" (local timestamp)' },
        schedule_value: { type: SchemaType.STRING, description: 'cron: "0 9 * * *" | interval: "3600000" | once: "2026-02-01T15:30:00"' },
      },
      required: ['prompt', 'schedule_type', 'schedule_value'],
    },
  },
];

// ─── Tool Executor ────────────────────────────────────────────────────────

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  containerInput: ContainerInput,
): Promise<string> {
  try {
    switch (name) {
      case 'bash':
        return await toolBash(String(args.command ?? ''));
      case 'read_file':
        return toolReadFile(String(args.path ?? ''), containerInput.isMain);
      case 'write_file':
        return toolWriteFile(String(args.path ?? ''), String(args.content ?? ''), containerInput.isMain);
      case 'list_directory':
        return toolListDirectory(args.path ? String(args.path) : undefined, containerInput.isMain);
      case 'send_message':
        return toolSendMessage(String(args.chat_jid ?? containerInput.chatJid), String(args.text ?? ''), containerInput.groupFolder);
      case 'web_fetch':
        return await toolWebFetch(String(args.url ?? ''));
      case 'schedule_task':
        return toolScheduleTask(String(args.prompt ?? ''), String(args.schedule_type ?? ''), String(args.schedule_value ?? ''), containerInput.chatJid, containerInput.groupFolder);
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ─── Gemini Query ─────────────────────────────────────────────────────────

type ChatSession = ReturnType<ReturnType<GoogleGenerativeAI['getGenerativeModel']>['startChat']>;

/**
 * Run a user prompt through Gemini with the tool loop.
 * Returns the final text response.
 */
async function runGeminiQuery(
  prompt: string,
  containerInput: ContainerInput,
  chat: ChatSession,
): Promise<string> {
  log(`Running query (${prompt.length} chars)...`);
  let result: GenerateContentResult = await chat.sendMessage(prompt);
  let toolRounds = 0;

  while (toolRounds < MAX_TOOL_ROUNDS) {
    const functionCalls = result.response.functionCalls();
    if (!functionCalls || functionCalls.length === 0) break;
    toolRounds++;
    log(`Tool round ${toolRounds}: ${functionCalls.map((c) => c.name).join(', ')}`);

    const functionResponses = await Promise.all(
      functionCalls.map(async (call) => {
        const output = await executeTool(call.name, call.args as Record<string, unknown>, containerInput);
        log(`  ${call.name} → ${output.slice(0, 120)}`);
        return { functionResponse: { name: call.name, response: { result: output } } };
      }),
    );
    result = await chat.sendMessage(functionResponses as Parameters<ChatSession['sendMessage']>[0]);
  }

  if (toolRounds >= MAX_TOOL_ROUNDS) {
    log(`Warning: reached MAX_TOOL_ROUNDS (${MAX_TOOL_ROUNDS}), returning current response`);
  }

  const text = result.response.text();
  log(`Query complete: ${text.length} chars, ${toolRounds} tool rounds`);
  return text;
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
  const primaryModel = process.env.GEMINI_PRIMARY_MODEL || 'gemini-2.5-pro-latest';

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
    `You are ${containerInput.assistantName || 'Andy'}, a personal assistant. Your working directory is /workspace/group/.`;

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: primaryModel,
    systemInstruction,
    tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
  });

  // One chat session per container invocation — keeps conversation history
  // across IPC follow-up messages within the same run.
  // NOTE: Sessions do not persist between container restarts (Gemini limitation).
  const chat = model.startChat({ history: [] });

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

  // Query loop: run Gemini query → emit output → wait for IPC → repeat
  try {
    while (true) {
      const text = await runGeminiQuery(prompt, containerInput, chat);
      writeOutput({ status: 'success', result: text });

      log('Query ended, waiting for next IPC message...');
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got follow-up message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({ status: 'error', result: null, error: errorMessage });
    process.exit(1);
  }
}

main();
