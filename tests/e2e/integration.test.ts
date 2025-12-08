import { afterAll, describe, expect, it } from "vitest";
import * as d from "../../src/dsl/ast";
import { WorkerPool } from "../../src/runtime/pool";
import { createInt32View, createMemoryForSize } from "../../src/runtime/sab";
import { Tag } from "../../src/runtime/tag";
import { compileWasm } from "../../src/runtime/wasm";
const kernel = d.module("map_kernel", [
	d.importMemory("env", "memory", {
		min: 1,
		max: 16,
		shared: true,
	}),
	d.func(
		"main",
		[d.param("start", "i32"), d.param("end", "i32"), d.param("delta", "i32")],
		[],
		[d.local("i", "i32"), d.local("ptr", "i32")],
		[
			d.localSet("i", d.localGet("start")),
			d.block("B", [
				d.loop("L", [
					d.brIf("B", d.i32GeU(d.localGet("i"), d.localGet("end"))),
					d.localSet("ptr", d.i32Shl(d.localGet("i"), d.i32Const(2))),
					d.i32Store(
						d.localGet("ptr"),
						d.i32Add(d.i32Load(d.localGet("ptr")), d.localGet("delta"))
					),
					d.localSet("i", d.i32Add(d.localGet("i"), d.i32Const(1))),
					d.br("L"),
				]),
			]),
		]
	),
	d.exportFunc("main"),
]);
let a = 0;
const time = async (fn: () => Promise<void>) => {
	let idx = a++;
	console.time(idx.toString());
	await fn();
	console.timeEnd(idx.toString());
};
type kernel_wasm = Tag<WebAssembly.Module, "map_kernel">;
let wasm: kernel_wasm = (await compileWasm(kernel)) as kernel_wasm;
wasm.name = kernel.name! as "map_kernel";
describe("E2E Parallel Execution", () => {
	const pool = new WorkerPool({
		concurrency: 4,
	});
	afterAll(() => {
		pool.terminate();
	});

	it("should run a parallel map operation using SharedArrayBuffer", async () => {
		// 1. Setup Memory
		const COUNT = 1000;
		// 1000 * 4 bytes = 4000 bytes. Fits in 1 WASM page (64KB).
		const memory = createMemoryForSize(COUNT * 4); // <-- 使用我新加的函数
		const view = createInt32View(memory); // <-- 直接基于 memory.buffer
		// Init data: [0, 1, 2, ...]
		for (let i = 0; i < COUNT; i++) view[i] = i;

		// 2. Define Kernel: arr[i] = arr[i] + 10

		// 3. Execute
		await pool.init();
		try {
			await time(async () => await pool.exec(wasm, COUNT, memory, [10]));
		} catch (error) {
			console.error("Execution error:", error);
			throw error;
		}
		// js bench

		// 4. Verify
		// 验证部分数据点，确保多线程没有遗漏
		console.log("view: ", view);
		expect(view[0]).toBe(10);
		expect(view[500]).toBe(510);
		expect(view[999]).toBe(1009);
		// js bench
		// time(() => {
		// 	for (let i = 0; i < COUNT; i++) view[i] += 10;
		// });
	});
});
