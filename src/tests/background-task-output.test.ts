import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AsyncTaskRuntime } from "../async-tasks.js";

describe("session-owned background output", () => {
  it("reads bounded byte pages only for announced tasks in this registry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-task-output-"));
    try {
      const path = join(directory, "command.output");
      await writeFile(path, "a".repeat(70000) + "tail");
      const runtime = new AsyncTaskRuntime(true, "session", async () => {});
      const foreign = new AsyncTaskRuntime(true, "other-session", async () => {});
      await runtime.taskStarted({
        taskId: "command",
        taskType: "local_bash",
        isBackgrounded: true,
        outputFilePath: path,
        toolCallId: "bash-tool",
      });
      await runtime.releaseHeld();
      await expect(foreign.readOutput("command", 0)).rejects.toThrow("not found");
      await expect(runtime.readOutput("command", -1)).rejects.toThrow("offset");
      await expect(runtime.readOutput("command", 0.5)).rejects.toThrow("offset");
      const first = await runtime.readOutput("command", 0);
      expect(first).toEqual({ text: "a".repeat(65536), nextOffset: 65536 });
      await runtime.taskNotification("command", "completed");
      expect(await runtime.readOutput("command", first.nextOffset)).toEqual({
        text: "a".repeat(4464) + "tail",
        nextOffset: 70004,
      });
      expect(await runtime.readOutput("command", 80000)).toEqual({ text: "", nextOffset: 80000 });
      runtime.clear();
      await expect(runtime.readOutput("command", 0)).rejects.toThrow("not found");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not invent output when the SDK has not supplied a log path", async () => {
    const runtime = new AsyncTaskRuntime(true, "session", async () => {});
    await runtime.taskStarted({
      taskId: "command",
      taskType: "local_bash",
      isBackgrounded: true,
      toolCallId: "bash-tool",
    });
    await runtime.releaseHeld();
    await expect(runtime.readOutput("command", 0)).rejects.toThrow("output path");
  });
});

it("distinguishes stop receipts from terminal task notifications", async () => {
  const updates: any[] = [];
  const runtime = new AsyncTaskRuntime(
    true,
    "session",
    async (event) => {
      updates.push(event.update);
    },
    { terminalEvidence: true },
  );
  await runtime.taskStarted({
    taskId: "command",
    taskType: "local_bash",
    isBackgrounded: true,
    toolCallId: "tool",
  });
  await runtime.releaseHeld();
  expect(runtime.claimStop("command")).toBe(true);
  await runtime.taskStopped("command");
  expect(
    updates.find((update) => update.sessionUpdate === "async_task_state_update")?._meta?.cloudcode
      ?.terminalEvidence,
  ).toBe("stop_receipt");
  await runtime.taskNotification("command", "completed");
  expect(updates.at(-1)).toMatchObject({
    state: "completed",
    _meta: { cloudcode: { terminalEvidence: "event" } },
  });
});

it("preserves UTF-8 characters across bounded output pages", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-output-unicode-"));
  try {
    const path = join(directory, "command.output");
    const text = "a".repeat(65535) + "中文😀tail";
    await writeFile(path, text);
    const runtime = new AsyncTaskRuntime(true, "session", async () => {});
    await runtime.taskStarted({
      taskId: "command",
      taskType: "local_bash",
      isBackgrounded: true,
      toolCallId: "tool",
      outputFilePath: path,
    });
    await runtime.releaseHeld();
    const first = await runtime.readOutput("command", 0);
    const second = await runtime.readOutput("command", first.nextOffset);
    expect(first.text + second.text).toBe(text);
    expect(second.nextOffset).toBe(Buffer.byteLength(text));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
