import { describe, expect, it } from "vitest";
import * as d from "../../src/dsl/ast";
import { Enum, match, Struct } from "../../src/macro";
import { instantiateWasmSync } from "../../src/runtime/wasm";

describe("Macro System", () => {
	it("should calculate Struct layout correctly", () => {
		// 布局测试：对齐与 Padding
		const TestStruct = Struct({
			a: "u8", // offset 0, size 1
			// padding: 3 bytes (align to 4)
			b: "i32", // offset 4, size 4
			c: "u16", // offset 8, size 2
			// padding: 2 bytes (align to 4 for total struct)
		});

		expect(TestStruct.offsets.a).toBe(0);
		expect(TestStruct.offsets.b).toBe(4);
		expect(TestStruct.offsets.c).toBe(8);
		expect(TestStruct.size).toBe(12); // 0..12
		expect(TestStruct.align).toBe(4);
	});

	it("should calculate Enum layout correctly", () => {
		const Shape = Enum({
			Point: Struct({ x: "f32", y: "f32" }), // Size 8
			Circle: Struct({ r: "f32" }), // Size 4
			Empty: null, // Size 0
		});

		// Tag (i32, 4 bytes) + Payload (Max 8 bytes)
		// Offset should be aligned.
		expect(Shape.tagOffset).toBe(0);
		expect(Shape.payloadOffset).toBe(4);
		expect(Shape.size).toBe(12);
	});

	it("should generate correct code for Struct access", () => {
		const Point = Struct({ x: "i32", y: "i32" });

		// 定义一个 WASM 函数：读取 Point.y
		const m = d.module("test", [
			// FIX: Must declare memory import in AST for this test environment
			d.importMemory("env", "memory", { min: 1 }),
			d.func(
				"read_y",
				[d.param("ptr", "i32")],
				[d.result("i32")],
				[],
				[
					// return ptr->y
					Point.at(d.localGet("ptr")).y.load(),
				]
			),
			d.exportFunc("read_y"),
		]);

		const mem = new WebAssembly.Memory({ initial: 1 });
		const instance = instantiateWasmSync(m, { env: { memory: mem } });

		// JS 侧写入数据
		const view = new Int32Array(mem.buffer);
		const PTR = 0;
		view[0] = 100; // x
		view[1] = 200; // y (offset 4)

		// WASM 读取
		const res = (instance.exports.read_y as Function)(PTR);
		expect(res).toBe(200);
	});

	it("should generate pattern matching code", () => {
		const State = Enum({
			Idle: null,
			Running: Struct({ speed: "i32" } as const), // Add "as const"
		});

		// logic: if Idle return 0, if Running return speed
		const m = d.module("test_match", [
			// FIX: Must declare memory import in AST
			d.importMemory("env", "memory", { min: 1 }),
			d.func(
				"check",
				[d.param("ptr", "i32")],
				[d.result("i32")],
				[],
				[
					match(
						State.at(d.localGet("ptr")),
						{
							Idle: () => [d.i32Const(0)],
							Running: (s) => [s.speed.load()],
						},
						() => [d.i32Const(-1)],
						"i32" // Pass expected result type
					),
				]
			),
			d.exportFunc("check"),
		]);

		const mem = new WebAssembly.Memory({ initial: 1 });
		const instance = instantiateWasmSync(m, { env: { memory: mem } });
		const view = new Int32Array(mem.buffer);

		// Case 1: Idle (Tag 0)
		view[0] = 0;
		expect((instance.exports.check as Function)(0)).toBe(0);

		// Case 2: Running (Tag 1, Speed 555)
		view[0] = 1;
		view[1] = 555; // Payload at offset 4
		expect((instance.exports.check as Function)(0)).toBe(555);
	});

	it("should handle multi-variant enum with br_table correctly", () => {
		// Test with 3+ variants to ensure br_table dispatch works correctly
		const TrafficLight = Enum({
			Red: null,
			Yellow: null,
			Green: null,
		});

		const m = d.module("test_traffic", [
			d.importMemory("env", "memory", { min: 1 }),
			d.func(
				"get_wait_time",
				[d.param("ptr", "i32")],
				[d.result("i32")],
				[],
				[
					match(
						TrafficLight.at(d.localGet("ptr")),
						{
							Red: () => [d.i32Const(30)],    // Wait 30 seconds
							Yellow: () => [d.i32Const(5)],  // Wait 5 seconds
							Green: () => [d.i32Const(0)],   // Go immediately
						},
						() => [d.i32Const(-1)], // Unknown state
						"i32"
					),
				]
			),
			d.exportFunc("get_wait_time"),
		]);

		const mem = new WebAssembly.Memory({ initial: 1 });
		const instance = instantiateWasmSync(m, { env: { memory: mem } });
		const view = new Int32Array(mem.buffer);

		// Test all variants
		view[0] = 0; // Red
		expect((instance.exports.get_wait_time as Function)(0)).toBe(30);

		view[0] = 1; // Yellow
		expect((instance.exports.get_wait_time as Function)(0)).toBe(5);

		view[0] = 2; // Green
		expect((instance.exports.get_wait_time as Function)(0)).toBe(0);

		// Test out-of-bounds (should hit default)
		view[0] = 99;
		expect((instance.exports.get_wait_time as Function)(0)).toBe(-1);
	});
});
