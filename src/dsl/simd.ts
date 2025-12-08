// src/dsl/simd.ts

import { isSimdSupported } from "../runtime";
import { Node } from "./ast";

// ==========================================
// 1. Feature Detection (Static)
// ==========================================

// Check specifically for WASM SIMD (Fixed-width 128-bit SIMD)
// We validate a tiny binary containing a SIMD instruction (v128.const).
export const SIMD_SUPPORTED = (() => {
	return isSimdSupported();
})();

// ==========================================
// 2. Constants & Metadata
// ==========================================

export const VECTOR_WIDTH_BYTES = 16;

export const LANES = {
	i8: 16,
	u8: 16,
	i16: 8,
	u16: 8,
	i32: 4,
	u32: 4,
	f32: 4,
	i64: 2,
	u64: 2,
	f64: 2,
} as const;

// ==========================================
// 3. Analysis Helpers
// ==========================================

/**
 * Checks if a scalar AST node has a direct SIMD equivalent.
 * Used by the auto-tuner to decide if a loop is worth vectorizing.
 */
export function canVectorize(node: Node): boolean {
	const op = node.op || node.type;
	if (
		[
			"i32.add",
			"i32.sub",
			"i32.mul",
			"f32.add",
			"f32.sub",
			"f32.mul",
			"f32.div",
			"f32.min",
			"f32.max",
			"f32.abs",
			"f32.neg",
			"i32.and",
			"i32.or",
			"i32.xor",
			"i32.not",
			"i32.load",
			"f32.load",
			"i32.store",
			"f32.store",
		].includes(op)
	)
		return true;
	return false;
}
/**
 * Helper to calculate alignment for SIMD operations.
 * SIMD generally prefers 16-byte alignment (log2 = 4).
 */
export function getSimdAlignment(scalarAlign: number = 0): number {
	// Suppress unused warning by using the variable logic, or just ignore it.
	// Logic: If user specifically requested 0 (byte-aligned), maybe we should respect it?
	// But v128 usually works best with some alignment.
	// For auto-vectorization, we usually assume the data layout is optimized (e.g. via our Struct macro).
	// So upgrading to 16-byte alignment is the standard optimization strategy.

	// Use scalarAlign to decide if we keep it loose?
	// If scalar was 1 byte aligned, maybe data is packed?
	if (scalarAlign === 1) return 0; // Keep packed if originally packed

	return 4; // Default to 16-byte alignment (2^4)
}
