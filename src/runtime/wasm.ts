// src/runtime/wasm.ts

import { ModuleNode } from "../dsl/ast";
import { emitBinary } from "../dsl/emit";

// ==========================================
// 1. Caching & Types
// ==========================================

export interface CompilationOptions {
	/**
	 * Enable module caching. Default: true.
	 */
	enableCaching?: boolean;
	/**
	 * Unique key for caching.
	 * If not provided, will try to use ModuleNode.name or binary length hash.
	 */
	cacheKey?: string;
	/**
	 * Custom import object for instantiation helpers.
	 */
	imports?: WebAssembly.Imports;
}

interface CachedModule {
	module: WebAssembly.Module;
	timestamp: number;
	hits: number;
}

// Simple LRU-like Cache
const CACHE_LIMIT = 100;
const wasmModuleCache = new Map<string, CachedModule>();

function pruneCache() {
	if (wasmModuleCache.size < CACHE_LIMIT) return;

	// Sort by timestamp/hits and remove oldest/least used
	// Simplified: remove the first (oldest inserted) for performance
	const keys = wasmModuleCache.keys();
	const first = keys.next();
	if (!first.done) wasmModuleCache.delete(first.value);
}

// ==========================================
// 2. Feature Detection
// ==========================================

// Lazy checks
let _simdSupported: boolean | undefined;
let _threadsSupported: boolean | undefined;

/**
 * Check if the runtime supports WebAssembly SIMD (v128).
 * Uses validation of a minimal SIMD binary (checking type section support).
 */
export function isSimdSupported(): boolean {
	if (_simdSupported !== undefined) return _simdSupported;

	try {
		if (
			typeof WebAssembly === "object" &&
			typeof WebAssembly.instantiate === "function"
		) {
			// Minimal binary with 1 function that has a v128 local, or just a type signature with v128.
			// Binary:
			// Magic (4) + Version (4)
			// Type Section (1) + Size (4) + Count (1) + Form (0x60) + 0 params + 1 result (0x7b = v128)
			// This is enough; if runtime doesn't support v128, it will fail to validate the type section.
			const buffer = new Uint8Array([
				0x00,
				0x61,
				0x73,
				0x6d,
				0x01,
				0x00,
				0x00,
				0x00, // Magic + Version
				0x01,
				0x05,
				0x01,
				0x60,
				0x00,
				0x01,
				0x7b, // Type: () -> (v128)
			]);

			_simdSupported = WebAssembly.validate(buffer);
		}
	} catch {
		_simdSupported = false;
	}
	return _simdSupported!;
}

/**
 * Check if the runtime supports SharedArrayBuffer and Atomics.
 *
 * 此检测包含三个层级：
 * 1. JS 环境是否定义了 SharedArrayBuffer。
 * 2. WebAssembly 引擎是否支持 'threads' 提案 (即识别 shared: true)。
 * 3. 浏览器的安全上下文 (COOP/COEP) 是否允许分配共享内存。
 */
export function isThreadsSupported(): boolean {
	if (_threadsSupported !== undefined) return _threadsSupported;

	try {
		// 1. 检查 JS 环境基础支持
		if (typeof SharedArrayBuffer === "undefined") {
			_threadsSupported = false;
			return false;
		}

		// 2. 实战检测：尝试创建一个最小的共享内存
		// 如果引擎不支持多线程，或者安全头(COOP/COEP)缺失，
		// new WebAssembly.Memory({ shared: true }) 会直接抛出 Error。
		// 这比 WebAssembly.validate 更可靠，因为它同时检查了安全策略。
		const mem = new WebAssembly.Memory({
			initial: 1,
			maximum: 1,
			shared: true,
		});

		// 3. 双重确认生成的 buffer 确实是 SharedArrayBuffer
		_threadsSupported = mem.buffer instanceof SharedArrayBuffer;
	} catch {
		// 捕获所有错误（包括 TypeError, LinkError, RangeError 等）
		_threadsSupported = false;
	}

	return _threadsSupported;
}

// ==========================================
// 3. Compilation Logic
// ==========================================

/**
 * Compiles a WASM source (AST or raw binary) into a WebAssembly.Module.
 * Handles Binary Emission (AST -> Uint8Array) and Caching automatically.
 */
export async function compileWasm(
	source: ModuleNode | Uint8Array,
	options: CompilationOptions = {}
): Promise<WebAssembly.Module> {
	const enableCaching = options.enableCaching ?? true;
	let binary: Uint8Array;
	let cacheKey = options.cacheKey;

	// 1. Convert AST to Binary if needed
	if (source instanceof Uint8Array) {
		binary = source;
		if (!cacheKey && enableCaching) {
			// Simple hash for binary: length + first/mid/last bytes
			const len = binary.length;
			if (len > 0) {
				cacheKey = `bin_${len}_${binary[0]}_${binary[len >> 1]}_${
					binary[len - 1]
				}`;
			} else {
				cacheKey = "bin_empty";
			}
		}
	} else {
		// Zero-overhead emission
		if (!cacheKey && enableCaching && source.name) {
			cacheKey = `ast_${source.name}`;
		}

		// Optimization: check cache BEFORE emission if possible
		if (enableCaching && cacheKey && wasmModuleCache.has(cacheKey)) {
			const cached = wasmModuleCache.get(cacheKey)!;
			cached.timestamp = Date.now();
			cached.hits++;
			return cached.module;
		}

		binary = emitBinary(source);
	}

	// 2. Check Cache
	if (enableCaching && cacheKey && wasmModuleCache.has(cacheKey)) {
		const cached = wasmModuleCache.get(cacheKey)!;
		cached.timestamp = Date.now();
		cached.hits++;
		return cached.module;
	}

	// 3. Compile
	const module = await WebAssembly.compile(binary as BufferSource);

	// 4. Update Cache
	if (enableCaching && cacheKey) {
		pruneCache();
		wasmModuleCache.set(cacheKey, {
			module,
			timestamp: Date.now(),
			hits: 1,
		});
	}

	return module;
}

// ==========================================
// 4. Instantiation Logic
// ==========================================

/**
 * Convenience wrapper to compile and instantiate in one go.
 */
export async function instantiateWasm(
	source: ModuleNode | Uint8Array,
	imports: WebAssembly.Imports = {},
	options: CompilationOptions = {}
): Promise<WebAssembly.WebAssemblyInstantiatedSource> {
	const module = await compileWasm(source, options);
	// 修复: WebAssembly.instantiate(module) 返回 Instance，需手动包装成 WebAssemblyInstantiatedSource
	const instance = await WebAssembly.instantiate(module, imports);
	return { instance, module };
}

/**
 * Sync version of instantiation (requires Module to be compiled synchronously or already ready).
 * Note: 'emitBinary' is synchronous, but 'new WebAssembly.Module' is synchronous only for small buffers
 * in some engines.
 */
export function instantiateWasmSync(
	source: ModuleNode | Uint8Array,
	imports: WebAssembly.Imports = {}
): WebAssembly.Instance {
	let binary: Uint8Array;
	if (source instanceof Uint8Array) {
		binary = source;
	} else {
		binary = emitBinary(source);
	}

	const module = new WebAssembly.Module(binary as BufferSource);
	return new WebAssembly.Instance(module, imports);
}

// ==========================================
// 5. Utility
// ==========================================

export function clearWasmCache() {
	wasmModuleCache.clear();
}

export function getWasmCacheStats() {
	return {
		size: wasmModuleCache.size,
		keys: Array.from(wasmModuleCache.keys()),
	};
}
