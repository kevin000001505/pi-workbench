import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";

export type RpcRecord = { type: string; [key: string]: unknown };

type Pending = { resolve: (data: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout };

/**
 * One `pi --mode rpc` child process. Splits stdout strictly on LF (not readline, which also splits on
 * U+2028/U+2029), correlates command responses by id, and emits every other record as "record".
 *
 * Events: "record" (RpcRecord), "stderr" (string), "exit" (code, signal).
 */
export class RpcProcess extends EventEmitter {
  private child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private decoder = new StringDecoder("utf8");
  private pending = new Map<string, Pending>();
  private nextId = 0;
  exited = false;
  /** Set by an intentional stop, so its exit isn't reported as a crash. */
  stopping = false;

  constructor(bin: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) {
    super();
    this.child = spawn(bin, ["--mode", "rpc", ...args], { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.on("data", (chunk: Buffer) => this.onData(this.decoder.write(chunk)));
    this.child.stderr.on("data", (chunk: Buffer) => this.emit("stderr", chunk.toString("utf8")));
    this.child.stdin.on("error", () => {});
    this.child.on("error", (err) => {
      this.emit("stderr", `failed to start pi: ${err.message}\n`);
      this.onExit(null, null);
    });
    this.child.on("exit", (code, signal) => this.onExit(code, signal));
  }

  get pid() {
    return this.child.pid;
  }

  /** Send a command and resolve with its response `data`; reject when `success` is false. */
  call<T = unknown>(command: RpcRecord, timeoutMs = 60_000): Promise<T> {
    if (this.exited) return Promise.reject(new Error("pi process has exited"));
    const id = `wb-${++this.nextId}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`pi did not answer ${command.type} within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (d: unknown) => void, reject, timer });
      this.write({ ...command, id });
    });
  }

  /** Write a record that has no response (extension_ui_response). */
  write(record: RpcRecord) {
    if (this.exited) return;
    this.child.stdin.write(`${JSON.stringify(record)}\n`);
  }

  /** Close stdin for an orderly shutdown; kill if pi doesn't exit in time. */
  stop(graceMs = 5_000): Promise<void> {
    if (this.exited) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.child.kill("SIGKILL"), graceMs);
      this.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      this.child.stdin.end();
    });
  }

  private onData(text: string) {
    this.buffer += text;
    let nl = this.buffer.indexOf("\n");
    while (nl !== -1) {
      let line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.trim()) this.onLine(line);
      nl = this.buffer.indexOf("\n");
    }
  }

  private onLine(line: string) {
    let record: RpcRecord;
    try {
      record = JSON.parse(line);
    } catch {
      this.emit("stderr", `unparseable stdout line: ${line.slice(0, 200)}\n`);
      return;
    }
    if (record.type === "response" && typeof record.id === "string" && this.pending.has(record.id)) {
      const p = this.pending.get(record.id)!;
      this.pending.delete(record.id);
      clearTimeout(p.timer);
      if (record.success) p.resolve(record.data);
      else p.reject(new Error(String(record.error ?? `${record.command} failed`)));
      return;
    }
    this.emit("record", record);
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null) {
    if (this.exited) return;
    this.exited = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("pi process exited"));
    }
    this.pending.clear();
    this.emit("exit", code, signal);
  }
}
