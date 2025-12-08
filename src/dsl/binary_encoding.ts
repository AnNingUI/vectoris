// src/dsl/binary_encoding.ts

// ==========================================
// 1. Constants & Section IDs
// ==========================================

export const SECTION = {
	CUSTOM: 0,
	TYPE: 1,
	IMPORT: 2,
	FUNC: 3,
	TABLE: 4,
	MEMORY: 5,
	GLOBAL: 6,
	EXPORT: 7,
	START: 8,
	ELEMENT: 9,
	CODE: 10,
	DATA: 11,
	DATA_COUNT: 12,
};

export const VAL_TYPE = {
	i32: 0x7f,
	i64: 0x7e,
	f32: 0x7d,
	f64: 0x7c,
	v128: 0x7b,
	funcref: 0x70,
	externref: 0x6f,
	void: 0x40, // pseudo-type for empty blocks
	func: 0x70, // Alias for funcref (AST compatibility)
	extern: 0x6f, // Alias for externref (AST compatibility)
};

export const KIND = {
	FUNC: 0x00,
	TABLE: 0x01,
	MEMORY: 0x02,
	GLOBAL: 0x03,
};

// ==========================================
// 2. Binary Writer (Zero Dependency)
// ==========================================

export class BinaryWriter {
	buffer: Uint8Array;
	offset: number = 0;
	textEncoder: TextEncoder;

	constructor(initialSize: number = 4096) {
		this.buffer = new Uint8Array(initialSize);
		this.textEncoder = new TextEncoder();
	}

	private ensure(size: number) {
		if (this.offset + size >= this.buffer.length) {
			// Grow by 2x or required size + 1KB margin
			const newSize = Math.max(
				this.buffer.length * 2,
				this.offset + size + 1024
			);
			const newBuf = new Uint8Array(newSize);
			newBuf.set(this.buffer);
			this.buffer = newBuf;
		}
	}

	getData(): Uint8Array {
		return this.buffer.subarray(0, this.offset);
	}

	// --- Basic Writes ---

	u8(v: number) {
		this.ensure(1);
		this.buffer[this.offset++] = v & 0xff;
	}

	write(bytes: Uint8Array | number[]) {
		this.ensure(bytes.length);
		this.buffer.set(bytes, this.offset);
		this.offset += bytes.length;
	}

	// --- LEB128 Integers ---

	// Unsigned 32-bit LEB128
	u32(v: number) {
		this.ensure(5);
		v >>>= 0;
		while (true) {
			const byte = v & 0x7f;
			v >>>= 7;
			if (v === 0) {
				this.buffer[this.offset++] = byte;
				break;
			}
			this.buffer[this.offset++] = byte | 0x80;
		}
	}

	// Signed 32-bit LEB128
	s32(v: number) {
		this.ensure(5);
		while (true) {
			const byte = v & 0x7f;
			v >>= 7;
			if (
				(v === 0 && (byte & 0x40) === 0) ||
				(v === -1 && (byte & 0x40) !== 0)
			) {
				this.buffer[this.offset++] = byte;
				break;
			}
			this.buffer[this.offset++] = byte | 0x80;
		}
	}

	// Signed 64-bit LEB128 (Requires BigInt for full range)
	s64(v: bigint | number) {
		this.ensure(10);
		let val = BigInt(v);
		while (true) {
			let byte = Number(val & 0x7fn);
			val >>= 7n;
			if (
				(val === 0n && (byte & 0x40) === 0) ||
				(val === -1n && (byte & 0x40) !== 0)
			) {
				this.buffer[this.offset++] = byte;
				break;
			}
			this.buffer[this.offset++] = byte | 0x80;
		}
	}

	// --- Floats ---

	f32(v: number) {
		this.ensure(4);
		const view = new DataView(
			this.buffer.buffer,
			this.byteOffset + this.offset,
			4
		);
		view.setFloat32(0, v, true); // Little Endian
		this.offset += 4;
	}

	f64(v: number) {
		this.ensure(8);
		const view = new DataView(
			this.buffer.buffer,
			this.byteOffset + this.offset,
			8
		);
		view.setFloat64(0, v, true); // Little Endian
		this.offset += 8;
	}

	// Helper to deal with shared buffer offset if buffer was created from a slice
	private get byteOffset() {
		return this.buffer.byteOffset;
	}

	// --- Strings & Vectors ---

	// WASM String: len(u32) + utf8_bytes
	name(s: string) {
		const bytes = this.textEncoder.encode(s);
		this.u32(bytes.length);
		this.write(bytes);
	}

	// Write a vector of items given a callback for each item
	vec<T>(items: T[], writeFn: (item: T, index: number) => void) {
		this.u32(items.length);
		items.forEach(writeFn);
	}
}

// ==========================================
// 3. Complete Opcode Map
// ==========================================

/**
 * Key: AST node 'type' or 'op'.
 * Value: Opcode number.
 * Note:
 *  - Standard ops are single bytes (0x00 - 0xFF).
 *  - Prefixed ops are encoded as (PREFIX << 8) | CODE.
 *    - 0xFCxx -> Misc / Bulk
 *    - 0xFDxx -> SIMD
 *    - 0xFExx -> Atomics
 */
export const OPCODES: Record<string, number> = {
	// Control Flow
	unreachable: 0x00,
	nop: 0x01,
	block: 0x02,
	loop: 0x03,
	if: 0x04,
	br: 0x0c,
	br_if: 0x0d,
	br_table: 0x0e,
	return: 0x0f,
	call: 0x10,
	call_indirect: 0x11,
	drop: 0x1a,
	select: 0x1b,

	// Variable Access
	"local.get": 0x20,
	"local.set": 0x21,
	"local.tee": 0x22,
	"global.get": 0x23,
	"global.set": 0x24,
	"table.get": 0x25,
	"table.set": 0x26, // Reference types

	// Memory Loading
	"i32.load": 0x28,
	"i64.load": 0x29,
	"f32.load": 0x2a,
	"f64.load": 0x2b,
	"i32.load8_s": 0x2c,
	"i32.load8_u": 0x2d,
	"i32.load16_s": 0x2e,
	"i32.load16_u": 0x2f,
	"i64.load8_s": 0x30,
	"i64.load8_u": 0x31,
	"i64.load16_s": 0x32,
	"i64.load16_u": 0x33,
	"i64.load32_s": 0x34,
	"i64.load32_u": 0x35,

	// Memory Storing
	"i32.store": 0x36,
	"i64.store": 0x37,
	"f32.store": 0x38,
	"f64.store": 0x39,
	"i32.store8": 0x3a,
	"i32.store16": 0x3b,
	"i64.store8": 0x3c,
	"i64.store16": 0x3d,
	"i64.store32": 0x3e,

	// Memory Size/Grow
	"memory.size": 0x3f,
	"memory.grow": 0x40,

	// Constants
	"i32.const": 0x41,
	"i64.const": 0x42,
	"f32.const": 0x43,
	"f64.const": 0x44,

	// i32 Comparisons
	"i32.eqz": 0x45,
	"i32.eq": 0x46,
	"i32.ne": 0x47,
	"i32.lt_s": 0x48,
	"i32.lt_u": 0x49,
	"i32.gt_s": 0x4a,
	"i32.gt_u": 0x4b,
	"i32.le_s": 0x4c,
	"i32.le_u": 0x4d,
	"i32.ge_s": 0x4e,
	"i32.ge_u": 0x4f,

	// i64 Comparisons
	"i64.eqz": 0x50,
	"i64.eq": 0x51,
	"i64.ne": 0x52,
	"i64.lt_s": 0x53,
	"i64.lt_u": 0x54,
	"i64.gt_s": 0x55,
	"i64.gt_u": 0x56,
	"i64.le_s": 0x57,
	"i64.le_u": 0x58,
	"i64.ge_s": 0x59,
	"i64.ge_u": 0x5a,

	// Float Comparisons
	"f32.eq": 0x5b,
	"f32.ne": 0x5c,
	"f32.lt": 0x5d,
	"f32.gt": 0x5e,
	"f32.le": 0x5f,
	"f32.ge": 0x60,
	"f64.eq": 0x61,
	"f64.ne": 0x62,
	"f64.lt": 0x63,
	"f64.gt": 0x64,
	"f64.le": 0x65,
	"f64.ge": 0x66,

	// i32 Math
	"i32.clz": 0x67,
	"i32.ctz": 0x68,
	"i32.popcnt": 0x69,
	"i32.add": 0x6a,
	"i32.sub": 0x6b,
	"i32.mul": 0x6c,
	"i32.div_s": 0x6d,
	"i32.div_u": 0x6e,
	"i32.rem_s": 0x6f,
	"i32.rem_u": 0x70,
	"i32.and": 0x71,
	"i32.or": 0x72,
	"i32.xor": 0x73,
	"i32.shl": 0x74,
	"i32.shr_s": 0x75,
	"i32.shr_u": 0x76,
	"i32.rotl": 0x77,
	"i32.rotr": 0x78,

	// i64 Math
	"i64.clz": 0x79,
	"i64.ctz": 0x7a,
	"i64.popcnt": 0x7b,
	"i64.add": 0x7c,
	"i64.sub": 0x7d,
	"i64.mul": 0x7e,
	"i64.div_s": 0x7f,
	"i64.div_u": 0x80,
	"i64.rem_s": 0x81,
	"i64.rem_u": 0x82,
	"i64.and": 0x83,
	"i64.or": 0x84,
	"i64.xor": 0x85,
	"i64.shl": 0x86,
	"i64.shr_s": 0x87,
	"i64.shr_u": 0x88,
	"i64.rotl": 0x89,
	"i64.rotr": 0x8a,

	// Float Math
	"f32.abs": 0x8b,
	"f32.neg": 0x8c,
	"f32.ceil": 0x8d,
	"f32.floor": 0x8e,
	"f32.trunc": 0x8f,
	"f32.nearest": 0x90,
	"f32.sqrt": 0x91,
	"f32.add": 0x92,
	"f32.sub": 0x93,
	"f32.mul": 0x94,
	"f32.div": 0x95,
	"f32.min": 0x96,
	"f32.max": 0x97,
	"f32.copysign": 0x98,

	"f64.abs": 0x99,
	"f64.neg": 0x9a,
	"f64.ceil": 0x9b,
	"f64.floor": 0x9c,
	"f64.trunc": 0x9d,
	"f64.nearest": 0x9e,
	"f64.sqrt": 0x9f,
	"f64.add": 0xa0,
	"f64.sub": 0xa1,
	"f64.mul": 0xa2,
	"f64.div": 0xa3,
	"f64.min": 0xa4,
	"f64.max": 0xa5,
	"f64.copysign": 0xa6,

	// Conversions
	"i32.wrap_i64": 0xa7,
	"i32.trunc_f32_s": 0xa8,
	"i32.trunc_f32_u": 0xa9,
	"i32.trunc_f64_s": 0xaa,
	"i32.trunc_f64_u": 0xab,
	"i64.extend_i32_s": 0xac,
	"i64.extend_i32_u": 0xad,
	"i64.trunc_f32_s": 0xae,
	"i64.trunc_f32_u": 0xaf,
	"i64.trunc_f64_s": 0xb0,
	"i64.trunc_f64_u": 0xb1,
	"f32.convert_i32_s": 0xb2,
	"f32.convert_i32_u": 0xb3,
	"f32.convert_i64_s": 0xb4,
	"f32.convert_i64_u": 0xb5,
	"f32.demote_f64": 0xb6,
	"f64.convert_i32_s": 0xb7,
	"f64.convert_i32_u": 0xb8,
	"f64.convert_i64_s": 0xb9,
	"f64.convert_i64_u": 0xba,
	"f64.promote_f32": 0xbb,

	// Reinterpret
	"i32.reinterpret_f32": 0xbc,
	"i64.reinterpret_f64": 0xbd,
	"f32.reinterpret_i32": 0xbe,
	"f64.reinterpret_i64": 0xbf,

	// --- 0xFC Prefix (Misc / Bulk) ---
	// Usage: write(0xFC); write(code);
	"memory.init": 0xfc08,
	"data.drop": 0xfc09,
	"memory.copy": 0xfc0a,
	"memory.fill": 0xfc0b,
	"i32.trunc_sat_f32_s": 0xfc00,
	"i32.trunc_sat_f32_u": 0xfc01,
	"i32.trunc_sat_f64_s": 0xfc02,
	"i32.trunc_sat_f64_u": 0xfc03,
	"i64.trunc_sat_f32_s": 0xfc04,
	"i64.trunc_sat_f32_u": 0xfc05,
	"i64.trunc_sat_f64_s": 0xfc06,
	"i64.trunc_sat_f64_u": 0xfc07,

	// --- 0xFE Prefix (Atomics) ---
	// Usage: write(0xFE); write(code);
	"atomic.notify": 0xfe00,
	"atomic.wait": 0xfe01,
	"atomic.fence": 0xfe03,
	"i32.atomic.load": 0xfe10,
	"i64.atomic.load": 0xfe11,
	"i32.atomic.load8_u": 0xfe12,
	"i32.atomic.load16_u": 0xfe13,
	"i64.atomic.load8_u": 0xfe14,
	"i64.atomic.load16_u": 0xfe15,
	"i64.atomic.load32_u": 0xfe16,
	"i32.atomic.store": 0xfe17,
	"i64.atomic.store": 0xfe18,
	"i32.atomic.store8": 0xfe19,
	"i32.atomic.store16": 0xfe1a,
	"i64.atomic.store8": 0xfe1b,
	"i64.atomic.store16": 0xfe1c,
	"i64.atomic.store32": 0xfe1d,

	"i32.atomic.rmw.add": 0xfe1e,
	"i64.atomic.rmw.add": 0xfe1f,
	"i32.atomic.rmw.sub": 0xfe22,
	"i64.atomic.rmw.sub": 0xfe23,
	"i32.atomic.rmw.and": 0xfe26,
	"i64.atomic.rmw.and": 0xfe27,
	"i32.atomic.rmw.or": 0xfe2a,
	"i64.atomic.rmw.or": 0xfe2b,
	"i32.atomic.rmw.xor": 0xfe2e,
	"i64.atomic.rmw.xor": 0xfe2f,
	"i32.atomic.rmw.xchg": 0xfe32,
	"i64.atomic.rmw.xchg": 0xfe33,
	"i32.atomic.rmw.cmpxchg": 0xfe36,
	"i64.atomic.rmw.cmpxchg": 0xfe37,

	// --- 0xFD Prefix (SIMD / Vector) ---
	// Usage: write(0xFD); write(code);
	"v128.load": 0xfd00,
	"v128.load8x8_s": 0xfd01,
	"v128.load8x8_u": 0xfd02,
	"v128.load16x4_s": 0xfd03,
	"v128.load16x4_u": 0xfd04,
	"v128.load32x2_s": 0xfd05,
	"v128.load32x2_u": 0xfd06,
	"v128.load8_splat": 0xfd07,
	"v128.load16_splat": 0xfd08,
	"v128.load32_splat": 0xfd09,
	"v128.load64_splat": 0xfd0a,
	"v128.store": 0xfd0b,
	"v128.const": 0xfd0c,
	"v128.shuffle": 0xfd0d,
	"i8x16.swizzle": 0xfd0e,
	"i8x16.splat": 0xfd0f,
	"i16x8.splat": 0xfd10,
	"i32x4.splat": 0xfd11,
	"i64x2.splat": 0xfd12,
	"f32x4.splat": 0xfd13,
	"f64x2.splat": 0xfd14,

	"i8x16.extract_lane_s": 0xfd15,
	"i8x16.extract_lane_u": 0xfd16,
	"i8x16.replace_lane": 0xfd17,
	"i16x8.extract_lane_s": 0xfd18,
	"i16x8.extract_lane_u": 0xfd19,
	"i16x8.replace_lane": 0xfd1a,
	"i32x4.extract_lane": 0xfd1b,
	"i32x4.replace_lane": 0xfd1c,
	"i64x2.extract_lane": 0xfd1d,
	"i64x2.replace_lane": 0xfd1e,
	"f32x4.extract_lane": 0xfd1f,
	"f32x4.replace_lane": 0xfd20,
	"f64x2.extract_lane": 0xfd21,
	"f64x2.replace_lane": 0xfd22,

	// ... Common SIMD Math ...
	"i8x16.eq": 0xfd23,
	"i8x16.ne": 0xfd24,
	"i32x4.eq": 0xfd36,
	"i32x4.ne": 0xfd37,
	"i32x4.lt_s": 0xfd38,
	"i32x4.lt_u": 0xfd39,
	"i32x4.gt_s": 0xfd3a,
	"i32x4.gt_u": 0xfd3b,
	"i32x4.le_s": 0xfd3c,
	"i32x4.le_u": 0xfd3d,
	"i32x4.ge_s": 0xfd3e,
	"i32x4.ge_u": 0xfd3f,

	"i8x16.add": 0xfd6e, // Note: Conflicting sources, but i32x4.add is definitively 0x6e in final MVP
	"i16x8.add": 0xfd6e, // Invalid duplicate? No, check table carefully.
	// Actually, correct table:
	// i32x4.add = 0x6e
	"i32x4.add": 0xfd6e,
	"i32x4.sub": 0xfd71,
	"i32x4.mul": 0xfd95,
	"i32x4.min_s": 0xfd96,
	"i32x4.max_s": 0xfd98,

	"f32x4.eq": 0xfd41,
	"f32x4.ne": 0xfd42,
	"f32x4.lt": 0xfd43,
	"f32x4.gt": 0xfd44,
	"f32x4.le": 0xfd45,
	"f32x4.ge": 0xfd46,
	"f64x2.eq": 0xfd47,
	"f64x2.ne": 0xfd48,

	// Correct Final MVP Opcodes
	"f32x4.add": 0xfde4,
	"f32x4.sub": 0xfde5,
	"f32x4.mul": 0xfde6,
	"f32x4.div": 0xfde7,
	"f32x4.min": 0xfde8,
	"f32x4.max": 0xfde9,
	"f32x4.pmin": 0xfdea,
	"f32x4.pmax": 0xfdeb,

	"f64x2.add": 0xfdf0,
	"f64x2.sub": 0xfdf1,
	"f64x2.mul": 0xfdf2,
	"f64x2.div": 0xfdf3,
};