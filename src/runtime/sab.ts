// src/runtime/sab.ts (updated)

// ==========================================
// 1. Constants & Checks
// ==========================================

export const WASM_PAGE_SIZE = 65536; // 64KB

export function isSABSupported(): boolean {
	return typeof SharedArrayBuffer !== "undefined";
}

export function isSharedArrayBuffer(buffer: any): buffer is SharedArrayBuffer {
	return (
		typeof SharedArrayBuffer !== "undefined" &&
		buffer instanceof SharedArrayBuffer
	);
}

// ==========================================
// 2. Buffer / Memory Creation
// ==========================================

export interface SABOptions {
	/**
	 * Size in bytes.
	 * Will be rounded UP to the nearest WASM page size (64KB) if meant for WASM Memory.
	 */
	size: number;
}

/**
 * Creates a SharedArrayBuffer aligned to WASM page size (64KB).
 * Use this when you only need a raw SAB (not a WebAssembly.Memory).
 */
export function createSharedBuffer(options: SABOptions): SharedArrayBuffer {
	if (!isSABSupported()) {
		throw new Error(
			"SharedArrayBuffer is not supported in this environment. Check COOP/COEP headers."
		);
	}

	const pages = Math.ceil(options.size / WASM_PAGE_SIZE);
	const alignedSize = pages * WASM_PAGE_SIZE;

	return new SharedArrayBuffer(alignedSize);
}

/**
 * Creates a WebAssembly.Memory instance sized to hold at least `sizeBytes`.
 *
 * IMPORTANT:
 * - You CANNOT create a WebAssembly.Memory from an *existing* SharedArrayBuffer.
 * - This function creates a new WebAssembly.Memory with `shared: true`.
 * - Callers should use `memory.buffer` as the authoritative SharedArrayBuffer.
 */
export function createMemoryForSize(
	sizeBytes: number,
	maxPages?: number
): WebAssembly.Memory {
	if (!isSABSupported()) {
		throw new Error(
			"SharedArrayBuffer / Shared WebAssembly.Memory is not supported in this environment."
		);
	}

	const pages = Math.ceil(sizeBytes / WASM_PAGE_SIZE);
	const max = maxPages || pages;

	return new WebAssembly.Memory({
		initial: pages,
		maximum: max,
		shared: true,
	});
}

/**
 * Alternative factory when you already know desired page count.
 */
export function createMemoryWithPages(
	initialPages: number,
	maxPages?: number
): WebAssembly.Memory {
	if (!isSABSupported()) {
		throw new Error(
			"SharedArrayBuffer / Shared WebAssembly.Memory is not supported in this environment."
		);
	}

	const max = maxPages || initialPages;
	return new WebAssembly.Memory({
		initial: initialPages,
		maximum: max,
		shared: true,
	});
}

// ==========================================
// 3. View Factories
// ==========================================

/**
 * Helper to create typed views on either a SharedArrayBuffer or a WebAssembly.Memory.
 * If 'target' is a WebAssembly.Memory, use its .buffer as the backing SAB.
 */
type BufferOrMemory = SharedArrayBuffer | WebAssembly.Memory | ArrayBufferLike;

function resolveBuffer(
	target: BufferOrMemory
): SharedArrayBuffer | ArrayBufferLike {
	// If memory was passed, use memory.buffer
	if ((target as WebAssembly.Memory).buffer !== undefined) {
		return (target as WebAssembly.Memory).buffer;
	}
	return target as SharedArrayBuffer | ArrayBufferLike;
}

export function createInt32View(
	target: BufferOrMemory,
	offset = 0,
	length?: number
): Int32Array {
	const buf = resolveBuffer(target);
	return new Int32Array(buf, offset, length);
}

export function createUint32View(
	target: BufferOrMemory,
	offset = 0,
	length?: number
): Uint32Array {
	const buf = resolveBuffer(target);
	return new Uint32Array(buf, offset, length);
}

export function createFloat32View(
	target: BufferOrMemory,
	offset = 0,
	length?: number
): Float32Array {
	const buf = resolveBuffer(target);
	return new Float32Array(buf, offset, length);
}

export function createFloat64View(
	target: BufferOrMemory,
	offset = 0,
	length?: number
): Float64Array {
	const buf = resolveBuffer(target);
	return new Float64Array(buf, offset, length);
}

export function createUint8View(
	target: BufferOrMemory,
	offset = 0,
	length?: number
): Uint8Array {
	const buf = resolveBuffer(target);
	return new Uint8Array(buf, offset, length);
}

// ==========================================
// 4. Atomic Utilities (Synchronization)
// ==========================================

export const AtomicOps = {
	store(view: Int32Array, index: number, value: number): number {
		return Atomics.store(view, index, value);
	},
	load(view: Int32Array, index: number): number {
		return Atomics.load(view, index);
	},
	add(view: Int32Array, index: number, value: number): number {
		return Atomics.add(view, index, value);
	},
	sub(view: Int32Array, index: number, value: number): number {
		return Atomics.sub(view, index, value);
	},
	wait(
		view: Int32Array,
		index: number,
		expectedValue: number,
		timeout = Infinity
	) {
		// Atomics.wait on main thread in browsers will throw; callers should be aware.
		// Type signature preserved from your original file.
		// @ts-ignore
		return Atomics.wait(view, index, expectedValue, timeout);
	},
	notify(view: Int32Array, index: number, count = 1): number {
		return Atomics.notify(view, index, count);
	},
	compareExchange(
		view: Int32Array,
		index: number,
		expected: number,
		replacement: number
	): number {
		return Atomics.compareExchange(view, index, expected, replacement);
	},
};

// SharedLock (unchanged, but use memory.buffer when constructing)
export class SharedLock {
	private i32: Int32Array;
	private index: number;

	constructor(target: BufferOrMemory, byteOffset: number = 0) {
		const buf = resolveBuffer(target);
		this.i32 = new Int32Array(buf, byteOffset, 1);
		this.index = 0;
	}

	async lockAsync() {
		for (let i = 0; i < 10; i++) {
			if (Atomics.compareExchange(this.i32, this.index, 0, 1) === 0) return;
		}
		while (true) {
			if (Atomics.compareExchange(this.i32, this.index, 0, 1) === 0) return;
			const result = (Atomics as any).waitAsync?.(this.i32, this.index, 1);
			if (result && result.async) {
				await result.value;
			} else {
				// immediate retry
			}
		}
	}

	unlock() {
		Atomics.store(this.i32, this.index, 0);
		Atomics.notify(this.i32, this.index, 1);
	}
}
