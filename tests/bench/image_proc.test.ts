import { beforeAll, describe, expect, it } from "vitest";
import * as d from "../../src/dsl/ast";
import { optimize } from "../../src/dsl/optimizer";
import { MainThreadExecutor } from "../../src/runtime/executor";
import { WorkerPool } from "../../src/runtime/pool";
import { isSimdSupported, isThreadsSupported } from "../../src/runtime/wasm";

const WIDTH = 3840;
const HEIGHT = 2160;
const BYTE_SIZE = WIDTH * HEIGHT * 4;

describe("Heavy Compute Benchmark", () => {
	let memory: WebAssembly.Memory;
	// @ts-ignore
	let buffer: SharedArrayBuffer;
	let view: Uint8Array;
	let heavyKernelAST: any;

	// 创建一个"重负载"内核：每个像素循环计算 500 次
	const createHeavyKernel = () => {
		return d.module("heavy_proc", [
			d.importMemory("env", "memory", {
				min: Math.ceil(BYTE_SIZE / 65536),
				max: Math.ceil(BYTE_SIZE / 65536),
				shared: true,
			}),
			d.func(
				"process",
				[
					d.param("start", "i32"),
					d.param("end", "i32"),
					d.param("dummy", "i32"),
				],
				[],
				[d.local("i", "i32"), d.local("j", "i32"), d.local("v", "v128")],
				[
					d.localSet("i", d.localGet("start")),
					d.block("break", [
						d.loop("top", [
							d.brIf("break", d.i32GeU(d.localGet("i"), d.localGet("end"))),

							// 1. Load
							d.localSet("v", d.v128Load(d.localGet("i"), 0, 4)),

							// 2. Heavy Compute Simulation
							d.localSet("j", d.i32Const(0)),
							
							d.block("compute_out", [
								d.loop("compute_burn", [
									d.brIf(
										"compute_out",
										d.i32GeU(d.localGet("j"), d.i32Const(500))
									),

									// Math logic: v = v + v + v (overflows deterministicly)
									d.localSet(
										"v",
										d.i32x4Add(
											d.localGet("v"),
											d.i32x4Add(d.localGet("v"), d.localGet("v"))
										)
									),

									d.localSet("j", d.i32Add(d.localGet("j"), d.i32Const(1))),
									d.br("compute_burn"),
								]),
							]),

							// 3. Store
							d.v128Store(d.localGet("i"), d.localGet("v"), 0, 4),

							d.localSet("i", d.i32Add(d.localGet("i"), d.i32Const(16))),
							d.br("top"),
						]),
					]),
				]
			),
			d.exportFunc("process"),
		]);
	};

	beforeAll(() => {
		if (!isSimdSupported() || !isThreadsSupported()) return;
		const pages = Math.ceil(BYTE_SIZE / 65536);
		memory = new WebAssembly.Memory({
			initial: pages,
			maximum: pages,
			shared: true,
		});
		buffer = memory.buffer as unknown as SharedArrayBuffer;
		view = new Uint8Array(buffer);
		heavyKernelAST = optimize(createHeavyKernel(), { level: 3 });
	});

	it("Heavy Load Comparison (Performance)", async () => {
		if (!heavyKernelAST) return;
		view.fill(1); // init

		// === MainThread ===
		const executor = new MainThreadExecutor({ baseSliceTime: 100 });
		const tMain = performance.now();
		await executor.run(heavyKernelAST, BYTE_SIZE, memory, [0], {
			entryPoint: "process",
		});
		const dMain = performance.now() - tMain;

		// === WorkerPool (8 Threads) ===
		view.fill(1); // reset
		const pool = new WorkerPool({ concurrency: 8 });
		await pool.init(); 

		const tPool = performance.now();
		await pool.exec(heavyKernelAST, BYTE_SIZE, memory, [0], {
			entryPoint: "process",
		});
		const dPool = performance.now() - tPool;
		pool.terminate();

		console.log(`\n=== Heavy Compute Benchmark (CPU Bound) ===`);
		console.table([
			{
				Method: "MainThread (SIMD)",
				Time: `${dMain.toFixed(2)}ms`,
				Speedup: "1.0x",
			},
			{
				Method: "WorkerPool (8 Threads)",
				Time: `${dPool.toFixed(2)}ms`,
				Speedup: `${(dMain / dPool).toFixed(2)}x`,
			},
		]);

		expect(dPool).toBeLessThan(dMain);
	});

    // 新增：数据一致性校验
	it("should produce identical results in both modes (Correctness)", async () => {
		if (!heavyKernelAST) return;

		// 1. 准备初始数据 (Pattern: 0, 1, 2, ... 255)
        // 使用非均匀数据，防止巧合
		for(let i=0; i < BYTE_SIZE; i++) {
            view[i] = i % 251; // Prime number modulo
        }
        
        // 备份初始数据，以便重置
        // 注意：SharedArrayBuffer 不能直接 slice，需要转 TypedArray
        const inputBackup = new Uint8Array(view);

		// 2. 运行基准 (MainThread - 黄金标准)
		const executor = new MainThreadExecutor();
		await executor.run(heavyKernelAST, BYTE_SIZE, memory, [0], { entryPoint: "process" });
		
        // 拷贝基准结果
        const baselineResult = new Uint8Array(view);

		// 3. 重置内存
        view.set(inputBackup);

		// 4. 运行测试对象 (WorkerPool)
		const pool = new WorkerPool({ concurrency: 8 });
		await pool.exec(heavyKernelAST, BYTE_SIZE, memory, [0], { entryPoint: "process" });
		pool.terminate();

        // 5. 逐字节比对
        // 我们不直接用 expect(view).toEqual(baseline)，因为 33MB 的 diff 输出会炸控制台
        let mismatchCount = 0;
        let firstMismatchIdx = -1;
        let diffA = 0, diffB = 0;

        for(let i = 0; i < BYTE_SIZE; i++) {
            if (view[i] !== baselineResult[i]) {
                if (mismatchCount === 0) {
                    firstMismatchIdx = i;
                    diffA = baselineResult[i];
                    diffB = view[i];
                }
                mismatchCount++;
            }
        }

        if (mismatchCount > 0) {
            console.error(`Data Mismatch! Count: ${mismatchCount} / ${BYTE_SIZE}`);
            console.error(`First mismatch at index ${firstMismatchIdx}: Expected ${diffA}, Got ${diffB}`);
        }

        // 验证数据确实被修改了（不是全 0 或全是初始值）
        // 随机抽查几个点，确保不是 inputBackup 的值
        const sampleIdx = 12345;
        console.log("view[sampleIdx]", view[sampleIdx])
        expect(view[sampleIdx]).not.toBe(inputBackup[sampleIdx]);

        // 验证一致性
        expect(mismatchCount).toBe(0);
	});
});