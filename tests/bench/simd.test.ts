import { describe, expect, it } from "vitest";
import { optimize } from "../../src/dsl"; // 确保引入了 optimize
import * as d from "../../src/dsl/ast";
import { autoVectorize } from "../../src/dsl/autotune";
import { compileWasm, isSimdSupported } from "../../src/runtime/wasm";

describe("SIMD Benchmark", () => {
	// ... (createScalarFunc 保持不变) ...
	const createScalarFunc = () =>
		d.func(
			"vec_add",
			[d.param("count", "i32"), d.param("ptr", "i32")],
			[],
			[d.local("i", "i32"), d.local("p", "i32")],
			[
				d.localSet("i", d.i32Const(0)),
				d.block("out", [
					d.loop("top", [
						d.brIf("out", d.i32GeU(d.localGet("i"), d.localGet("count"))),
						d.localSet(
							"p",
							d.i32Add(
								d.localGet("ptr"),
								d.i32Shl(d.localGet("i"), d.i32Const(2))
							)
						),
						d.f32Store(
							d.localGet("p"),
							d.f32Add(d.f32Load(d.localGet("p")), d.f32Const(1.0))
						),
						d.localSet("i", d.i32Add(d.localGet("i"), d.i32Const(1))),
						d.br("top"),
					]),
				]),
			]
		);

	it("benchmark: scalar vs simd execution", async () => {
		if (!isSimdSupported()) return;

		const COUNT = 65536 * 10;
		const MEM_PAGES = Math.ceil((COUNT * 4) / 65536) + 1;
		const memory = new WebAssembly.Memory({
			initial: MEM_PAGES,
			maximum: MEM_PAGES,
			shared: true,
		});

		// 1. 创建内存视图以便读取结果
		const memF32 = new Float32Array(memory.buffer);

		// Scalar Module
		const modScalar = d.module("bench_scalar", [
			d.importMemory("env", "memory", {
				min: MEM_PAGES,
				max: MEM_PAGES,
				shared: true,
			}),
			createScalarFunc(),
			d.exportFunc("vec_add"),
		]);

		const instScalar = await WebAssembly.instantiate(
			await compileWasm(modScalar),
			{ env: { memory } }
		);
		const runScalar = instScalar.exports.vec_add as Function;

		// SIMD Module (Optimized)
		const scalarNode = createScalarFunc();
		const vecResult = autoVectorize(scalarNode);
		const modSimd = d.module("bench_simd", [
			d.importMemory("env", "memory", {
				min: MEM_PAGES,
				max: MEM_PAGES,
				shared: true,
			}),
			// 启用 O3 和 循环展开
			optimize(vecResult.func, {
				level: 3,
				unrollFactor: 4,
			}),
			d.exportFunc(vecResult.func.name!),
		]);

		let instSimd: WebAssembly.Instance;
		try {
			instSimd = await WebAssembly.instantiate(await compileWasm(modSimd), {
				env: { memory },
			});
		} catch (err) {
			console.error("SIMD module failed to instantiate", err);
			throw err;
		}
		const runSimd = instSimd.exports[vecResult.func.name!] as Function;

		const ITERATIONS = 100;

		// --- Run Scalar ---
		// 初始化内存为 0
		memF32.fill(0);
		const t0 = performance.now();
		for (let k = 0; k < ITERATIONS; k++) runScalar(COUNT, 0);
		const dScalar = performance.now() - t0;

		// 读取 Scalar 跑完后的第一个值
		const valScalar = memF32[0];

		// --- Run SIMD ---
		// 重置内存为 0 (为了公平对比和验证正确性)
		memF32.fill(0);
		const t1 = performance.now();
		for (let k = 0; k < ITERATIONS; k++) runSimd(COUNT, 0);
		const dSimd = performance.now() - t1;

		// 读取 SIMD 跑完后的第一个值
		const valSimd = memF32[0];

		// 验证：最后几个元素也应该是 100 (检查循环边界是否正确)
		const valSimdLast = memF32[COUNT - 1];

		console.log(`\nBenchmark Results (${COUNT} floats x ${ITERATIONS} iters):`);
		console.table([
			{ Method: "Scalar", Time: `${dScalar.toFixed(2)}ms`, Result: valScalar },
			{ Method: "SIMD*", Time: `${dSimd.toFixed(2)}ms`, Result: valSimd },
		]);
		console.log(`SIMD Last Element: ${valSimdLast}`); // 应该是 100

		// 断言：结果必须正确 (跑了100次 +1，结果应为 100)
		expect(valScalar).toBe(ITERATIONS);
		expect(valSimd).toBe(ITERATIONS);
		expect(valSimdLast).toBe(ITERATIONS); // 确保没有遗漏尾部数据

		expect(dSimd).toBeLessThan(dScalar); // SIMD 应该更快
	});
});
