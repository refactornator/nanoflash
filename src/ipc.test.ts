/**
 * Tests for src/ipc.ts — covers:
 *   - processTaskIpc: update_task, unknown types, edge cases not in ipc-auth.test.ts
 *   - startIpcWatcher: file scanning, message/reaction sending, auth, error handling
 */

import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, createTask, getTaskById } from './db.js';
import {
  _resetIpcWatcherForTests,
  IpcDeps,
  processTaskIpc,
  startIpcWatcher,
} from './ipc.js';
import { RegisteredGroup } from './types.js';

// ---------------------------------------------------------------------------
// File-level mocks (apply to every test in this file)
// ---------------------------------------------------------------------------

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('./config.js', () => ({
  DATA_DIR: '/fake/data',
  IPC_POLL_INTERVAL: 50,
  TIMEZONE: 'UTC',
  STORE_DIR: '/fake/store',
  ASSISTANT_NAME: 'Sergey',
  GROUPS_DIR: '/fake/groups',
}));

// Minimal fs mock — only the methods used by ipc.ts
vi.mock('fs', () => ({
  default: {
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    statSync: vi.fn(() => ({ isDirectory: () => false })),
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => '{}'),
    unlinkSync: vi.fn(),
    renameSync: vi.fn(),
  },
}));

// Typed reference to the mocked fs default export
const fsMock = vi.mocked(fs);

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'whatsapp_main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

const OTHER_GROUP: RegisteredGroup = {
  name: 'Other',
  folder: 'other-group',
  trigger: '@Sergey',
  added_at: '2024-01-01T00:00:00.000Z',
};

function makeTaskDeps(
  groups: Record<string, RegisteredGroup>,
  overrides: Partial<IpcDeps> = {},
): IpcDeps {
  return {
    sendMessage: vi.fn(async () => {}),
    sendReaction: vi.fn(async () => {}),
    registeredGroups: () => groups,
    registerGroup: vi.fn(),
    syncGroups: vi.fn(async () => {}),
    getAvailableGroups: vi.fn(() => []),
    writeGroupsSnapshot: vi.fn(),
    onTasksChanged: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// processTaskIpc — update_task
// (follows the same pattern as ipc-auth.test.ts with a real in-memory DB)
// ---------------------------------------------------------------------------

describe('processTaskIpc: update_task', () => {
  let groups: Record<string, RegisteredGroup>;
  let deps: IpcDeps;

  beforeEach(() => {
    _initTestDatabase();

    groups = {
      'main@g.us': MAIN_GROUP,
      'other@g.us': OTHER_GROUP,
    };
    deps = makeTaskDeps(groups);

    createTask({
      id: 'task-update',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'original prompt',
      script: null,
      schedule_type: 'interval',
      schedule_value: '3600000',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
  });

  it('main group can update prompt on any task', async () => {
    await processTaskIpc(
      { type: 'update_task', taskId: 'task-update', prompt: 'updated prompt' },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getTaskById('task-update')?.prompt).toBe('updated prompt');
    expect(deps.onTasksChanged).toHaveBeenCalledOnce();
  });

  it('non-main group can update its own task', async () => {
    await processTaskIpc(
      { type: 'update_task', taskId: 'task-update', prompt: 'new prompt' },
      'other-group',
      false,
      deps,
    );

    expect(getTaskById('task-update')?.prompt).toBe('new prompt');
    expect(deps.onTasksChanged).toHaveBeenCalledOnce();
  });

  it('non-main group cannot update another groups task', async () => {
    // sourceGroup is 'whatsapp_main' (isMain=false) but task belongs to 'other-group'
    await processTaskIpc(
      { type: 'update_task', taskId: 'task-update', prompt: 'sneaky' },
      'whatsapp_main',
      false,
      deps,
    );

    // 'whatsapp_main' folder ≠ 'other-group' and isMain=false → blocked
    expect(getTaskById('task-update')?.prompt).toBe('original prompt');
    expect(deps.onTasksChanged).not.toHaveBeenCalled();
  });

  it('does nothing when task not found', async () => {
    await processTaskIpc(
      { type: 'update_task', taskId: 'no-such-task', prompt: 'x' },
      'whatsapp_main',
      true,
      deps,
    );

    expect(deps.onTasksChanged).not.toHaveBeenCalled();
  });

  it('updates script field', async () => {
    await processTaskIpc(
      { type: 'update_task', taskId: 'task-update', script: 'echo hello' },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getTaskById('task-update')?.script).toBe('echo hello');
  });

  it('clears script when empty string provided', async () => {
    // First set a script
    await processTaskIpc(
      { type: 'update_task', taskId: 'task-update', script: 'echo hi' },
      'whatsapp_main',
      true,
      deps,
    );
    // Then clear it
    await processTaskIpc(
      { type: 'update_task', taskId: 'task-update', script: '' },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getTaskById('task-update')?.script).toBeNull();
  });

  it('updates schedule_type and recomputes next_run for cron', async () => {
    await processTaskIpc(
      {
        type: 'update_task',
        taskId: 'task-update',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const task = getTaskById('task-update');
    expect(task?.schedule_type).toBe('cron');
    expect(task?.next_run).not.toBeNull();
    expect(new Date(task!.next_run!).getTime()).toBeGreaterThan(Date.now() - 5000);
  });

  it('rejects invalid cron expression in update_task and does not call onTasksChanged', async () => {
    await processTaskIpc(
      {
        type: 'update_task',
        taskId: 'task-update',
        schedule_type: 'cron',
        schedule_value: 'not-a-cron',
      },
      'whatsapp_main',
      true,
      deps,
    );

    // prompt should be unchanged (break before updateTask call)
    expect(getTaskById('task-update')?.prompt).toBe('original prompt');
    expect(deps.onTasksChanged).not.toHaveBeenCalled();
  });

  it('recomputes next_run for interval schedule update', async () => {
    const before = Date.now();

    await processTaskIpc(
      {
        type: 'update_task',
        taskId: 'task-update',
        schedule_type: 'interval',
        schedule_value: '7200000', // 2 hours
      },
      'whatsapp_main',
      true,
      deps,
    );

    const task = getTaskById('task-update');
    expect(task?.schedule_type).toBe('interval');
    expect(task?.schedule_value).toBe('7200000');
    const nextRun = new Date(task!.next_run!).getTime();
    expect(nextRun).toBeGreaterThanOrEqual(before + 7200000 - 1000);
    expect(nextRun).toBeLessThanOrEqual(Date.now() + 7200000 + 1000);
  });

  it('no-op when taskId is missing', async () => {
    await processTaskIpc(
      { type: 'update_task' /* no taskId */ },
      'whatsapp_main',
      true,
      deps,
    );

    expect(deps.onTasksChanged).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// processTaskIpc — unknown / unhandled types
// ---------------------------------------------------------------------------

describe('processTaskIpc: unknown type', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('logs a warning and does nothing for an unknown type', async () => {
    const deps = makeTaskDeps({ 'main@g.us': MAIN_GROUP });

    await expect(
      processTaskIpc({ type: 'does_not_exist' }, 'whatsapp_main', true, deps),
    ).resolves.toBeUndefined();

    expect(deps.onTasksChanged).not.toHaveBeenCalled();
  });

  it('handles empty type gracefully', async () => {
    const deps = makeTaskDeps({ 'main@g.us': MAIN_GROUP });

    await expect(
      processTaskIpc({ type: '' }, 'whatsapp_main', true, deps),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// processTaskIpc — register_group preserves isMain on update
// ---------------------------------------------------------------------------

describe('processTaskIpc: register_group isMain preservation', () => {
  let groups: Record<string, RegisteredGroup>;
  let deps: IpcDeps;

  beforeEach(() => {
    _initTestDatabase();

    groups = {
      'main@g.us': MAIN_GROUP,
      'existing@g.us': {
        name: 'Existing',
        folder: 'existing-group',
        trigger: '@Bot',
        added_at: '2024-01-01T00:00:00.000Z',
        isMain: true, // pre-existing isMain flag
      },
    };
    deps = makeTaskDeps(groups, {
      registerGroup: vi.fn((jid, group) => {
        groups[jid] = group;
      }),
    });
  });

  it('preserves isMain from existing group registration', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'existing@g.us',
        name: 'Existing Updated',
        folder: 'existing-group',
        trigger: '@BotNew',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(groups['existing@g.us']?.isMain).toBe(true);
    expect(groups['existing@g.us']?.name).toBe('Existing Updated');
  });

  it('new group does not get isMain flag when registered via IPC', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'brand-new@g.us',
        name: 'New Group',
        folder: 'new-group',
        trigger: '@Bot',
      },
      'whatsapp_main',
      true,
      deps,
    );

    // No existing entry → isMain should be undefined (not forced true)
    expect(groups['brand-new@g.us']?.isMain).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// startIpcWatcher — filesystem-level behaviour
//
// Each test calls _resetIpcWatcherForTests() so the running-guard is always
// clear, and vi.resetAllMocks() so there is no cross-test mock leakage.
// Default fs mock implementations are re-established after the reset.
// ---------------------------------------------------------------------------

describe('startIpcWatcher', () => {
  beforeEach(() => {
    _resetIpcWatcherForTests();
    vi.resetAllMocks(); // clears call history AND pending once-queues
    // Re-establish sensible defaults (factory impls are wiped by resetAllMocks)
    vi.mocked(fsMock.readdirSync).mockReturnValue([] as any);
    vi.mocked(fsMock.statSync).mockReturnValue({ isDirectory: () => false } as any);
    vi.mocked(fsMock.existsSync).mockReturnValue(false as any);
    vi.mocked(fsMock.readFileSync).mockReturnValue('{}' as any);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Flush all microtasks from one processIpcFiles() cycle.
   * processIpcFiles is async; each await inside it (sendMessage,
   * sendReaction, processTaskIpc) resolves as a microtask.  Three
   * Promise.resolve() calls covers the common case.
   */
  async function flushOneCycle(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  // ----- message sending ---------------------------------------------------

  it('calls sendMessage for a valid message file', async () => {
    const msgPayload = JSON.stringify({
      type: 'message',
      chatJid: 'main@g.us',
      text: 'Hello from IPC',
    });

    vi.mocked(fsMock.statSync).mockReturnValueOnce({ isDirectory: () => true } as any);
    vi.mocked(fsMock.readdirSync)
      .mockReturnValueOnce(['main_group'] as any) // ipcBaseDir
      .mockReturnValueOnce(['msg-001.json'] as any) // messagesDir
      .mockReturnValueOnce([] as any); // tasksDir
    vi.mocked(fsMock.existsSync)
      .mockReturnValueOnce(true)  // messagesDir exists
      .mockReturnValueOnce(false); // tasksDir absent
    vi.mocked(fsMock.readFileSync).mockReturnValueOnce(msgPayload as any);

    const deps = makeTaskDeps({
      'main@g.us': { name: 'Main', folder: 'main_group', trigger: 'always', added_at: '', isMain: true },
    });

    startIpcWatcher(deps);
    await flushOneCycle();

    expect(deps.sendMessage).toHaveBeenCalledOnce();
    expect(deps.sendMessage).toHaveBeenCalledWith('main@g.us', 'Hello from IPC', undefined);
  });

  it('passes replyTo field through to sendMessage', async () => {
    const msgPayload = JSON.stringify({
      type: 'message',
      chatJid: 'main@g.us',
      text: 'Replying',
      replyTo: 'orig-msg-id',
    });

    vi.mocked(fsMock.statSync).mockReturnValueOnce({ isDirectory: () => true } as any);
    vi.mocked(fsMock.readdirSync)
      .mockReturnValueOnce(['main_group'] as any)
      .mockReturnValueOnce(['reply.json'] as any)
      .mockReturnValueOnce([] as any);
    vi.mocked(fsMock.existsSync)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    vi.mocked(fsMock.readFileSync).mockReturnValueOnce(msgPayload as any);

    const deps = makeTaskDeps({
      'main@g.us': { name: 'Main', folder: 'main_group', trigger: 'always', added_at: '', isMain: true },
    });

    startIpcWatcher(deps);
    await flushOneCycle();

    expect(deps.sendMessage).toHaveBeenCalledWith('main@g.us', 'Replying', 'orig-msg-id');
  });

  it('deletes message file after successful processing', async () => {
    const msgPayload = JSON.stringify({ type: 'message', chatJid: 'main@g.us', text: 'Hi' });

    vi.mocked(fsMock.statSync).mockReturnValueOnce({ isDirectory: () => true } as any);
    vi.mocked(fsMock.readdirSync)
      .mockReturnValueOnce(['main_group'] as any)
      .mockReturnValueOnce(['hi.json'] as any)
      .mockReturnValueOnce([] as any);
    vi.mocked(fsMock.existsSync)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    vi.mocked(fsMock.readFileSync).mockReturnValueOnce(msgPayload as any);

    const deps = makeTaskDeps({
      'main@g.us': { name: 'Main', folder: 'main_group', trigger: 'always', added_at: '', isMain: true },
    });

    startIpcWatcher(deps);
    await flushOneCycle();

    expect(fsMock.unlinkSync).toHaveBeenCalledOnce();
    expect(fsMock.unlinkSync).toHaveBeenCalledWith(expect.stringContaining('hi.json'));
    expect(fsMock.renameSync).not.toHaveBeenCalled();
  });

  // ----- reaction sending --------------------------------------------------

  it('calls sendReaction for a valid reaction file', async () => {
    const rxnPayload = JSON.stringify({
      type: 'reaction',
      chatJid: 'main@g.us',
      messageId: 'msg-123',
      emoji: '👍',
    });

    vi.mocked(fsMock.statSync).mockReturnValueOnce({ isDirectory: () => true } as any);
    vi.mocked(fsMock.readdirSync)
      .mockReturnValueOnce(['main_group'] as any)
      .mockReturnValueOnce(['rxn.json'] as any)
      .mockReturnValueOnce([] as any);
    vi.mocked(fsMock.existsSync)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    vi.mocked(fsMock.readFileSync).mockReturnValueOnce(rxnPayload as any);

    const deps = makeTaskDeps({
      'main@g.us': { name: 'Main', folder: 'main_group', trigger: 'always', added_at: '', isMain: true },
    });

    startIpcWatcher(deps);
    await flushOneCycle();

    expect(deps.sendReaction).toHaveBeenCalledOnce();
    expect(deps.sendReaction).toHaveBeenCalledWith('main@g.us', 'msg-123', '👍');
    expect(fsMock.unlinkSync).toHaveBeenCalledOnce();
  });

  it('skips reaction silently when sendReaction dep is absent, but still deletes file', async () => {
    const rxnPayload = JSON.stringify({
      type: 'reaction',
      chatJid: 'main@g.us',
      messageId: 'msg-x',
      emoji: '❤️',
    });

    vi.mocked(fsMock.statSync).mockReturnValueOnce({ isDirectory: () => true } as any);
    vi.mocked(fsMock.readdirSync)
      .mockReturnValueOnce(['main_group'] as any)
      .mockReturnValueOnce(['rxn2.json'] as any)
      .mockReturnValueOnce([] as any);
    vi.mocked(fsMock.existsSync)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    vi.mocked(fsMock.readFileSync).mockReturnValueOnce(rxnPayload as any);

    const deps = makeTaskDeps(
      { 'main@g.us': { name: 'Main', folder: 'main_group', trigger: 'always', added_at: '', isMain: true } },
      { sendReaction: undefined },
    );

    startIpcWatcher(deps);
    await flushOneCycle();

    // File is still deleted (processed, just no sendReaction fn)
    expect(fsMock.unlinkSync).toHaveBeenCalledOnce();
  });

  // ----- authorization -----------------------------------------------------

  it('blocks non-main group sending to another group — sendMessage not called', async () => {
    const msgPayload = JSON.stringify({
      type: 'message',
      chatJid: 'main@g.us', // belongs to main_group, not other_group
      text: 'Unauthorized',
    });

    vi.mocked(fsMock.statSync).mockReturnValueOnce({ isDirectory: () => true } as any);
    vi.mocked(fsMock.readdirSync)
      .mockReturnValueOnce(['other_group'] as any)
      .mockReturnValueOnce(['hack.json'] as any)
      .mockReturnValueOnce([] as any);
    vi.mocked(fsMock.existsSync)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    vi.mocked(fsMock.readFileSync).mockReturnValueOnce(msgPayload as any);

    const deps = makeTaskDeps({
      'main@g.us': { name: 'Main', folder: 'main_group', trigger: 'always', added_at: '', isMain: true },
      'other@g.us': { name: 'Other', folder: 'other_group', trigger: '@Bot', added_at: '' },
    });

    startIpcWatcher(deps);
    await flushOneCycle();

    expect(deps.sendMessage).not.toHaveBeenCalled();
    // File is deleted even on auth block (it was processed)
    expect(fsMock.unlinkSync).toHaveBeenCalledOnce();
  });

  it('allows non-main group to send a message to its own chat', async () => {
    const msgPayload = JSON.stringify({
      type: 'message',
      chatJid: 'other@g.us',
      text: 'Self message',
    });

    vi.mocked(fsMock.statSync).mockReturnValueOnce({ isDirectory: () => true } as any);
    vi.mocked(fsMock.readdirSync)
      .mockReturnValueOnce(['other_group'] as any)
      .mockReturnValueOnce(['self.json'] as any)
      .mockReturnValueOnce([] as any);
    vi.mocked(fsMock.existsSync)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    vi.mocked(fsMock.readFileSync).mockReturnValueOnce(msgPayload as any);

    const deps = makeTaskDeps({
      'other@g.us': { name: 'Other', folder: 'other_group', trigger: '@Bot', added_at: '' },
    });

    startIpcWatcher(deps);
    await flushOneCycle();

    expect(deps.sendMessage).toHaveBeenCalledOnce();
    expect(deps.sendMessage).toHaveBeenCalledWith('other@g.us', 'Self message', undefined);
  });

  it('main group can send a message to a different group', async () => {
    const msgPayload = JSON.stringify({
      type: 'message',
      chatJid: 'other@g.us', // belongs to other_group, not main_group
      text: 'Cross-group from main',
    });

    vi.mocked(fsMock.statSync).mockReturnValueOnce({ isDirectory: () => true } as any);
    vi.mocked(fsMock.readdirSync)
      .mockReturnValueOnce(['main_group'] as any)
      .mockReturnValueOnce(['cross.json'] as any)
      .mockReturnValueOnce([] as any);
    vi.mocked(fsMock.existsSync)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    vi.mocked(fsMock.readFileSync).mockReturnValueOnce(msgPayload as any);

    const deps = makeTaskDeps({
      'other@g.us': { name: 'Other', folder: 'other_group', trigger: '@Bot', added_at: '' },
    });
    // make main_group the main group via isMain-lookup
    deps.registeredGroups = () => ({
      'main@g.us': { name: 'Main', folder: 'main_group', trigger: 'always', added_at: '', isMain: true },
      'other@g.us': { name: 'Other', folder: 'other_group', trigger: '@Bot', added_at: '' },
    });

    startIpcWatcher(deps);
    await flushOneCycle();

    expect(deps.sendMessage).toHaveBeenCalledOnce();
    expect(deps.sendMessage).toHaveBeenCalledWith('other@g.us', 'Cross-group from main', undefined);
  });

  // ----- error handling ----------------------------------------------------

  it('moves malformed JSON message file to errors directory', async () => {
    vi.mocked(fsMock.statSync).mockReturnValueOnce({ isDirectory: () => true } as any);
    vi.mocked(fsMock.readdirSync)
      .mockReturnValueOnce(['main_group'] as any)
      .mockReturnValueOnce(['bad.json'] as any)
      .mockReturnValueOnce([] as any);
    vi.mocked(fsMock.existsSync)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    vi.mocked(fsMock.readFileSync).mockReturnValueOnce('NOT VALID JSON' as any);

    const deps = makeTaskDeps({});

    startIpcWatcher(deps);
    await flushOneCycle();

    expect(fsMock.mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('errors'),
      { recursive: true },
    );
    expect(fsMock.renameSync).toHaveBeenCalledOnce();
    expect(fsMock.renameSync).toHaveBeenCalledWith(
      expect.stringContaining('bad.json'),
      expect.stringContaining('main_group-bad.json'),
    );
    expect(fsMock.unlinkSync).not.toHaveBeenCalled();
  });

  it('moves file to errors directory when sendMessage throws', async () => {
    const msgPayload = JSON.stringify({
      type: 'message',
      chatJid: 'main@g.us',
      text: 'fail please',
    });

    vi.mocked(fsMock.statSync).mockReturnValueOnce({ isDirectory: () => true } as any);
    vi.mocked(fsMock.readdirSync)
      .mockReturnValueOnce(['main_group'] as any)
      .mockReturnValueOnce(['fail.json'] as any)
      .mockReturnValueOnce([] as any);
    vi.mocked(fsMock.existsSync)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    vi.mocked(fsMock.readFileSync).mockReturnValueOnce(msgPayload as any);

    const deps = makeTaskDeps(
      { 'main@g.us': { name: 'Main', folder: 'main_group', trigger: 'always', added_at: '', isMain: true } },
      { sendMessage: vi.fn(async () => { throw new Error('network failure'); }) },
    );

    startIpcWatcher(deps);
    await flushOneCycle();

    expect(fsMock.renameSync).toHaveBeenCalledOnce();
    expect(fsMock.renameSync).toHaveBeenCalledWith(
      expect.stringContaining('fail.json'),
      expect.stringContaining('errors'),
    );
    expect(fsMock.unlinkSync).not.toHaveBeenCalled();
  });

  it('moves malformed task JSON file to errors directory', async () => {
    vi.mocked(fsMock.statSync).mockReturnValueOnce({ isDirectory: () => true } as any);
    // messagesDir is absent so readdirSync is only called for ipcBaseDir + tasksDir (not messagesDir)
    vi.mocked(fsMock.readdirSync)
      .mockReturnValueOnce(['main_group'] as any)    // ipcBaseDir
      .mockReturnValueOnce(['bad-task.json'] as any); // tasksDir
    vi.mocked(fsMock.existsSync)
      .mockReturnValueOnce(false)  // messagesDir absent
      .mockReturnValueOnce(true);  // tasksDir present
    vi.mocked(fsMock.readFileSync).mockReturnValueOnce('{not json' as any);

    const deps = makeTaskDeps({});

    startIpcWatcher(deps);
    await flushOneCycle();

    expect(fsMock.renameSync).toHaveBeenCalledOnce();
    expect(fsMock.renameSync).toHaveBeenCalledWith(
      expect.stringContaining('bad-task.json'),
      expect.stringContaining('main_group-bad-task.json'),
    );
  });

  // ----- file management ---------------------------------------------------

  it('ignores files that do not end in .json', async () => {
    vi.mocked(fsMock.statSync).mockReturnValueOnce({ isDirectory: () => true } as any);
    vi.mocked(fsMock.readdirSync)
      .mockReturnValueOnce(['main_group'] as any)
      .mockReturnValueOnce(['ignore.txt', 'ignore', '.hidden'] as any)
      .mockReturnValueOnce([] as any);
    vi.mocked(fsMock.existsSync)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    const deps = makeTaskDeps({});

    startIpcWatcher(deps);
    await flushOneCycle();

    expect(fsMock.readFileSync).not.toHaveBeenCalled();
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('does not process messages when messagesDir does not exist', async () => {
    vi.mocked(fsMock.statSync).mockReturnValueOnce({ isDirectory: () => true } as any);
    vi.mocked(fsMock.readdirSync).mockReturnValueOnce(['main_group'] as any);
    // Both dirs absent
    vi.mocked(fsMock.existsSync).mockReturnValue(false as any);

    const deps = makeTaskDeps({});

    startIpcWatcher(deps);
    await flushOneCycle();

    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(fsMock.unlinkSync).not.toHaveBeenCalled();
  });

  it('skips top-level entries that are plain files (not directories)', async () => {
    vi.mocked(fsMock.readdirSync).mockReturnValueOnce(['somefile.txt'] as any);
    vi.mocked(fsMock.statSync).mockReturnValueOnce({ isDirectory: () => false } as any);

    const deps = makeTaskDeps({});

    startIpcWatcher(deps);
    await flushOneCycle();

    expect(deps.sendMessage).not.toHaveBeenCalled();
    // existsSync should not be called for messagesDir/tasksDir
    expect(fsMock.existsSync).not.toHaveBeenCalled();
  });

  it('does not process the reserved "errors" directory as a group', async () => {
    vi.mocked(fsMock.readdirSync)
      .mockReturnValueOnce(['errors', 'real_group'] as any) // ipcBaseDir
      .mockReturnValueOnce([] as any)                        // real_group/messages
      .mockReturnValueOnce([] as any);                       // real_group/tasks
    vi.mocked(fsMock.statSync)
      .mockReturnValueOnce({ isDirectory: () => true } as any) // errors
      .mockReturnValueOnce({ isDirectory: () => true } as any); // real_group
    vi.mocked(fsMock.existsSync).mockReturnValue(false as any);

    const deps = makeTaskDeps({});

    startIpcWatcher(deps);
    await flushOneCycle();

    // readdirSync should NOT have been called for errors/messages or errors/tasks
    const calls = vi.mocked(fsMock.readdirSync).mock.calls.map((args) => String(args[0]));
    expect(calls.some((p) => p.includes('/errors/messages') || p.includes('/errors/tasks'))).toBe(false);
  });

  // ----- missing required fields -------------------------------------------

  it('skips message with missing chatJid — file still deleted', async () => {
    const msgPayload = JSON.stringify({ type: 'message', text: 'no jid here' });

    vi.mocked(fsMock.statSync).mockReturnValueOnce({ isDirectory: () => true } as any);
    vi.mocked(fsMock.readdirSync)
      .mockReturnValueOnce(['main_group'] as any)
      .mockReturnValueOnce(['nojid.json'] as any)
      .mockReturnValueOnce([] as any);
    vi.mocked(fsMock.existsSync)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    vi.mocked(fsMock.readFileSync).mockReturnValueOnce(msgPayload as any);

    const deps = makeTaskDeps({});

    startIpcWatcher(deps);
    await flushOneCycle();

    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(fsMock.unlinkSync).toHaveBeenCalledOnce();
  });

  it('skips message with missing text — file still deleted', async () => {
    const msgPayload = JSON.stringify({ type: 'message', chatJid: 'main@g.us' });

    vi.mocked(fsMock.statSync).mockReturnValueOnce({ isDirectory: () => true } as any);
    vi.mocked(fsMock.readdirSync)
      .mockReturnValueOnce(['main_group'] as any)
      .mockReturnValueOnce(['notext.json'] as any)
      .mockReturnValueOnce([] as any);
    vi.mocked(fsMock.existsSync)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    vi.mocked(fsMock.readFileSync).mockReturnValueOnce(msgPayload as any);

    const deps = makeTaskDeps({});

    startIpcWatcher(deps);
    await flushOneCycle();

    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(fsMock.unlinkSync).toHaveBeenCalledOnce();
  });

  it('skips reaction with missing emoji — file still deleted', async () => {
    const rxnPayload = JSON.stringify({
      type: 'reaction',
      chatJid: 'main@g.us',
      messageId: 'msg-99',
      // emoji absent
    });

    vi.mocked(fsMock.statSync).mockReturnValueOnce({ isDirectory: () => true } as any);
    vi.mocked(fsMock.readdirSync)
      .mockReturnValueOnce(['main_group'] as any)
      .mockReturnValueOnce(['noemoji.json'] as any)
      .mockReturnValueOnce([] as any);
    vi.mocked(fsMock.existsSync)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    vi.mocked(fsMock.readFileSync).mockReturnValueOnce(rxnPayload as any);

    const deps = makeTaskDeps({
      'main@g.us': { name: 'Main', folder: 'main_group', trigger: 'always', added_at: '', isMain: true },
    });

    startIpcWatcher(deps);
    await flushOneCycle();

    expect(deps.sendReaction).not.toHaveBeenCalled();
    expect(fsMock.unlinkSync).toHaveBeenCalledOnce();
  });

  // ----- task file processing ----------------------------------------------

  it('processes a valid task file and deletes it', async () => {
    // Use a real in-memory DB so we can verify deleteTask ran
    _initTestDatabase();

    createTask({
      id: 'task-to-cancel',
      group_folder: 'main_group',
      chat_jid: 'main@g.us',
      prompt: 'do it',
      script: null,
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const taskPayload = JSON.stringify({ type: 'cancel_task', taskId: 'task-to-cancel' });

    vi.mocked(fsMock.statSync).mockReturnValueOnce({ isDirectory: () => true } as any);
    // messagesDir is absent so readdirSync is only called for ipcBaseDir + tasksDir (not messagesDir)
    vi.mocked(fsMock.readdirSync)
      .mockReturnValueOnce(['main_group'] as any)  // ipcBaseDir
      .mockReturnValueOnce(['cancel.json'] as any); // tasksDir
    vi.mocked(fsMock.existsSync)
      .mockReturnValueOnce(false) // messagesDir absent
      .mockReturnValueOnce(true); // tasksDir present
    vi.mocked(fsMock.readFileSync).mockReturnValueOnce(taskPayload as any);

    const deps = makeTaskDeps({
      'main@g.us': { name: 'Main', folder: 'main_group', trigger: 'always', added_at: '', isMain: true },
    });

    startIpcWatcher(deps);
    await flushOneCycle();

    expect(getTaskById('task-to-cancel')).toBeUndefined();
    expect(fsMock.unlinkSync).toHaveBeenCalledOnce();
  });

  // ----- watcher lifecycle -------------------------------------------------

  it('deduplicates — second startIpcWatcher call is a no-op', async () => {
    vi.mocked(fsMock.readdirSync).mockReturnValue([] as any);

    const deps = makeTaskDeps({});

    startIpcWatcher(deps);
    startIpcWatcher(deps); // second call must be silently ignored

    await flushOneCycle();

    // mkdirSync for the ipc base dir is called exactly once
    const ipcMkdirCalls = vi.mocked(fsMock.mkdirSync).mock.calls.filter(
      (args) => typeof args[0] === 'string' && (args[0] as string).includes('/fake/data/ipc'),
    );
    expect(ipcMkdirCalls.length).toBe(1);
  });

  it('schedules the next poll cycle via setTimeout', async () => {
    vi.mocked(fsMock.readdirSync).mockReturnValue([] as any);

    const deps = makeTaskDeps({});

    startIpcWatcher(deps);
    await flushOneCycle();

    // Advance past IPC_POLL_INTERVAL (50 ms in mock) to fire the next cycle
    await vi.advanceTimersByTimeAsync(60);

    // readdirSync should have been called at least twice (first + second cycle)
    expect(vi.mocked(fsMock.readdirSync).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('handles IPC base directory read error gracefully and reschedules', async () => {
    // First readdirSync call throws
    vi.mocked(fsMock.readdirSync).mockImplementationOnce(() => {
      throw new Error('permission denied');
    });

    const deps = makeTaskDeps({});

    // Should not throw
    startIpcWatcher(deps);
    await flushOneCycle();

    // After the error, a retry should be scheduled; advance to trigger it
    vi.mocked(fsMock.readdirSync).mockReturnValueOnce([] as any);
    await vi.advanceTimersByTimeAsync(60);

    // readdirSync was attempted again — error was non-fatal
    expect(vi.mocked(fsMock.readdirSync).mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
