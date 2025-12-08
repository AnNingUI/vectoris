import { ModuleNode } from "../dsl/ast";
import { Tag } from "./tag";
import { compileWasm } from "./wasm";

// ==========================================
// Constants & Types
// ==========================================

// Message Protocol
const CMD_INIT = 0;
const CMD_RUN_ATOMIC = 1;
const RES_DONE = 2;
const RES_ERROR = 3;

// Worker 内部源码 (无外部依赖，自包含)
const WORKER_CODE = `
let inst = null;
let func = null;
let mem = null;

// 环境适配
const isNode = typeof process !== "undefined" && process.versions && process.versions.node;
let postMsg;

if (isNode) {
  const { parentPort } = require("worker_threads");
  postMsg = (d) => parentPort.postMessage(d);
  parentPort.on("message", (data) => handleMessage(data));
} else {
  postMsg = (d) => self.postMessage(d);
  self.onmessage = (e) => handleMessage(e.data);
}

// 预定义常量 (与主线程保持一致)
const CMD_INIT = 0;
const CMD_RUN_ATOMIC = 1;
const RES_DONE = 2;
const RES_ERROR = 3;

async function handleMessage(msg) {
  if (!msg) return;

  // --- INIT 阶段 ---
  if (msg.cmd === CMD_INIT) {
    try {
      const { mod, mem: memory } = msg;
      const imports = { env: { memory } };
      
      const res = await WebAssembly.instantiate(mod, imports);
      inst = res.instance || res;
      mem = memory;
      
      // 查找入口函数
      const exp = inst.exports;
      func = exp["process"] || exp["main"] || Object.values(exp)[0];
      
      // 发送简单的 ACK (复用 DONE 信号表示初始化完成)
      postMsg({ type: RES_DONE });
    } catch (err) {
      postMsg({ type: RES_ERROR, msg: err.message });
    }
    return;
  }

  // --- RUN ATOMIC 阶段 ---
  if (msg.cmd === CMD_RUN_ATOMIC) {
    try {
      if (!inst || !func) throw new Error("Not initialized");

      const { total, chunk, cursorBuffer, params } = msg;
      const cursorView = new Int32Array(cursorBuffer);

      // Work Stealing Loop
      while (true) {
        const start = Atomics.add(cursorView, 0, chunk);
        if (start >= total) break;
        const end = Math.min(start + chunk, total);
        
        // 极速调用
        func(start, end, ...params);
      }

      postMsg({ type: RES_DONE });

    } catch (err) {
      postMsg({ type: RES_ERROR, msg: err.message });
    }
  }
};
`;

export interface PoolOptions {
	concurrency?: number;
}

export interface ExecOptions {
	entryPoint?: string;
}

interface WorkerSlot {
	worker: any;
	busy: boolean;
}

// ==========================================
// AtomicWorkerPool (Ultra Optimized)
// ==========================================

export class WorkerPool {
	private slots: WorkerSlot[] = [];
	private concurrency: number;
	private isDisposed = false;
	private lastModuleId: string | null = null;

	// 全局原子计数器
	private syncBuffer: SharedArrayBuffer;
	private syncView: Int32Array;

	constructor(options: PoolOptions = {}) {
		const defaultConcurrency =
			typeof navigator !== "undefined" ? navigator.hardwareConcurrency : 4;
		this.concurrency = options.concurrency || defaultConcurrency || 4;

		this.syncBuffer = new SharedArrayBuffer(4);
		this.syncView = new Int32Array(this.syncBuffer);
	}

	async init(): Promise<void> {
		if (this.slots.length > 0) return;

		const isNode =
			typeof process !== "undefined" &&
			process.versions &&
			process.versions.node;

		let NodeWorker: any;
		if (isNode) {
			const mod = await import("node:worker_threads");
			NodeWorker = mod.Worker;
		}

		for (let i = 0; i < this.concurrency; i++) {
			let worker: any;
			if (isNode) {
				worker = new NodeWorker(WORKER_CODE, { eval: true });
			} else {
				const blob = new Blob([WORKER_CODE], {
					type: "application/javascript",
				});
				const url = URL.createObjectURL(blob);
				worker = new Worker(url);
			}
			this.slots.push({ worker, busy: false });
		}
	}

	async exec(
		kernel: ModuleNode | Tag<WebAssembly.Module, string>,
		totalSize: number,
		memory: WebAssembly.Memory,
		params: number[] = [],
		_options: ExecOptions = {}
	): Promise<void> {
		if (this.slots.length === 0) await this.init();
		if (this.isDisposed) throw new Error("Pool disposed");

		const module =
			kernel instanceof WebAssembly.Module ? kernel : await compileWasm(kernel);
		const moduleId = (kernel as any).name || "unknown";

		// 1. 初始化 / 热更新
		if (this.lastModuleId !== moduleId) {
			const initPromises = this.slots.map((slot) => {
				return new Promise<void>((resolve, reject) => {
					const onMsg = (arg: any) => {
						const data = arg.data || arg;

						// 清理监听 (规范写法)
						const w = slot.worker;
						if (w.removeEventListener) {
							w.removeEventListener("message", onMsg);
						} else {
							w.off("message", onMsg);
						}

						if (data.type === RES_ERROR) {
							reject(new Error(data.msg));
						} else {
							(() => RES_DONE)();
							resolve();
						}
					};

					const w = slot.worker;
					if (w.addEventListener) {
						w.addEventListener("message", onMsg);
					} else {
						w.on("message", onMsg);
					}

					w.postMessage({
						cmd: CMD_INIT,
						mod: module,
						mem: memory,
					});
				});
			});
			await Promise.all(initPromises);
			this.lastModuleId = moduleId;
		}

		// 2. 准备原子调度
		Atomics.store(this.syncView, 0, 0);

		// 块大小调优:
		// 目标: 减少 Atomics 争抢频率，同时保证负载均衡
		// 经验值: 每个线程分到 16 个块比较理想
		const optimalChunk = Math.max(
			Math.ceil(totalSize / (this.concurrency * 16)),
			1024 // 最小块 1K，避免太碎
		);

		// 3. 广播执行
		const runPromises = this.slots.map((slot) => {
			return new Promise<void>((resolve, reject) => {
				const onMsg = (arg: any) => {
					const data = arg.data || arg;

					const w = slot.worker;
					if (w.removeEventListener) {
						w.removeEventListener("message", onMsg);
					} else {
						w.off("message", onMsg);
					}

					if (data.type === RES_ERROR) {
						reject(new Error(data.msg));
					} else {
						resolve();
					}
				};

				const w = slot.worker;
				if (w.addEventListener) {
					w.addEventListener("message", onMsg);
				} else {
					w.on("message", onMsg);
				}

				// 发送轻量指令
				w.postMessage({
					cmd: CMD_RUN_ATOMIC,
					total: totalSize,
					chunk: optimalChunk,
					cursorBuffer: this.syncBuffer,
					params: params,
				});
			});
		});

		await Promise.all(runPromises);
	}

	terminate() {
		this.isDisposed = true;
		this.slots.forEach((s) => s.worker.terminate());
		this.slots = [];
	}
}
