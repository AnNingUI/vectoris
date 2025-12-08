import { ModuleNode } from "../dsl/ast";
import { Tag } from "./tag";
import { compileWasm } from "./wasm";

// ==========================================
// Options & Interfaces
// ==========================================

export interface ExecutorOptions {
	/**
	 * 基础时间片大小 (ms)。
	 * 默认 5ms，保持极高响应度。
	 */
	baseSliceTime?: number;
	/**
	 * 在无用户输入时的最大连续执行时间 (ms)。
	 * 默认 50ms (RAIL 模型建议响应在 100ms 内，50ms 是安全值)。
	 * 仅在支持 isInputPending 的环境中生效。
	 */
	maxContinuousTime?: number;
	debug?: boolean;
}

export interface RunOptions {
	/**
	 * WASM 模块中的导出函数名，默认为 "main"
	 */
	entryPoint?: string;
}

// ==========================================
// Scheduler Helpers
// ==========================================

// 声明 isInputPending API (TS 默认库可能不包含)
interface Scheduling {
	isInputPending(options?: { includeContinuous?: boolean }): boolean;
}
interface NavigatorWithScheduling extends Navigator {
	scheduling?: Scheduling;
}

/**
 * 检查是否有挂起的用户输入 (鼠标点击、按键等)
 */
function hasPendingInput(): boolean {
	if (
		typeof navigator !== "undefined" &&
		(navigator as NavigatorWithScheduling).scheduling?.isInputPending
	) {
		return (navigator as NavigatorWithScheduling).scheduling!.isInputPending({
			includeContinuous: true,
		});
	}
	// 如果不支持该 API，悲观假设总是有输入，强制遵守 baseSliceTime
	return true;
}

/**
 * 让出主线程控制权。
 * 使用 MessageChannel 实现 Macro-task yield (比 setTimeout 更快)。
 */
const yieldToMain = (() => {
	if (typeof MessageChannel !== "undefined") {
		const channel = new MessageChannel();
		const port = channel.port2;
		return () =>
			new Promise<void>((resolve) => {
				channel.port1.onmessage = () => resolve();
				port.postMessage(null);
			});
	} else {
		return () => new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
})();

// ==========================================
// MainThreadExecutor
// ==========================================

export class MainThreadExecutor {
	private options: Required<ExecutorOptions>;
	private isAborted = false;

	constructor(options: ExecutorOptions = {}) {
		this.options = {
			baseSliceTime: 5, // 默认非常灵敏
			maxContinuousTime: 50, // 允许 burst 执行
			debug: false,
			...options,
		};
	}

	private log(...args: any[]) {
		if (this.options.debug) console.debug("[MainThreadExecutor]", ...args);
	}

	/**
	 * 运行任务
	 */
	async run(
		kernel: ModuleNode | Tag<WebAssembly.Module, string>,
		totalSize: number,
		memory: WebAssembly.Memory,
		params: number[] = [],
		options: RunOptions = {}
	): Promise<void> {
		this.isAborted = false;

		// 1. 编译 Module
		// 如果已经是 Module 实例则直接使用，否则编译
		const module =
			kernel instanceof WebAssembly.Module ? kernel : await compileWasm(kernel);

		// 2. 实例化 (修复 TS 类型错误)
		const imports: WebAssembly.Imports = {
			env: { memory },
		};

		let instance: WebAssembly.Instance;
		try {
			// 显式处理 instantiate 的多态返回类型
			const result = await WebAssembly.instantiate(module, imports);

			// 类型守卫：检查是否返回了 { instance, module } 结构
			if (
				"instance" in result &&
				result.instance instanceof WebAssembly.Instance
			) {
				instance = result.instance;
			} else {
				// 否则它本身就是 Instance
				instance = result as WebAssembly.Instance;
			}
		} catch (err) {
			console.error("[MainThreadExecutor] Instantiation failed:", err);
			throw err;
		}

		// 3. 获取入口函数
		const entryPointName = options.entryPoint || "main";
		const entryFunc = instance.exports[entryPointName] as Function;

		if (typeof entryFunc !== "function") {
			throw new Error(`Export '${entryPointName}' not found in WASM module.`);
		}

		// 4. 启动调度器
		await this.scheduleExecution(entryFunc, totalSize, params);
	}

	/**
	 * 核心调度逻辑：时间切片 + 输入预测
	 */
	private async scheduleExecution(
		entryFunc: Function,
		totalSize: number,
		params: number[]
	): Promise<void> {
		let current = 0;
		// 初始步长
		let step = 256;

		const { baseSliceTime, maxContinuousTime } = this.options;

		// 动态调整的时间片阈值
		let currentSliceLimit = baseSliceTime;

		this.log(`Start: total=${totalSize}, baseSlice=${baseSliceTime}ms`);

		while (current < totalSize) {
			if (this.isAborted) return;

			const sliceStart = performance.now();
			let sliceDuration = 0;

			// --- 内层循环：密集计算 ---
			while (current < totalSize) {
				// 计算本次处理范围
				const end = current + step > totalSize ? totalSize : current + step;

				// 执行 WASM
				entryFunc(current, end, ...params);

				current = end;

				// 检查时间
				sliceDuration = performance.now() - sliceStart;

				// 1. 基础时间片检查
				if (sliceDuration >= currentSliceLimit) {
					// 2. 高级优化：如果没有输入挂起，且未达到最大连续时间，则续命
					if (!hasPendingInput() && sliceDuration < maxContinuousTime) {
						// 延长本轮时间片，继续执行而不 Yield
						// 逐步增加阈值，避免频繁检查 isInputPending
						currentSliceLimit = Math.min(
							currentSliceLimit + 5,
							maxContinuousTime
						);
					} else {
						// 必须让出
						break;
					}
				}

				// --- 动态步长调整 ---
				// 目标：让一次 chunk 耗时约为 0.5ms ~ 1ms，既不阻塞检测，又减少调用开销
				// 如果当前 step 跑得太快 (< 0.1ms)，指数级增加步长
				if (sliceDuration < 0.1) {
					step = Math.min(step * 4, totalSize - current);
					if (step < 16) step = 16;
				} else if (sliceDuration < 1.0) {
					// 线性增加
					step = Math.min(Math.floor(step * 1.5), totalSize - current);
				}
			}

			// --- 外层循环：让出控制权 ---
			if (current < totalSize) {
				// 重置时间片阈值为基础值
				currentSliceLimit = baseSliceTime;

				// Macro-task Yield
				await yieldToMain();
			}
		}

		this.log("Completed");
	}

	abort() {
		this.isAborted = true;
	}
}
