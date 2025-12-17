// src/macro/index.ts

import {
	Node,
	ValueType,
	block,
	br,
	brTable,
	f32Load,
	f32Store,
	f64Load,
	f64Store,
	i32Add,
	i32Const,
	i32Eq,
	i32Load,
	i32Load16_s,
	i32Load16_u,
	i32Load8_s,
	i32Load8_u,
	i32Mul,
	i32Store,
	i32Store16,
	i32Store8,
	i64Load,
	i64Store,
} from "../dsl/ast";

// ==========================================
// 1. Primitive Type System
// ==========================================

export type PrimitiveType =
	| "bool"
	| "u8"
	| "i8"
	| "u16"
	| "i16"
	| "i32"
	| "u32"
	| "i64"
	| "u64"
	| "f32"
	| "f64";

interface TypeMeta {
	size: number;
	align: number;
	load: (ptr: Node, offset: number) => Node;
	store: (ptr: Node, val: Node, offset: number) => Node;
}

const ALIGN_1 = 0;
const ALIGN_2 = 1;
const ALIGN_4 = 2;
const ALIGN_8 = 3;

const PRIMITIVES: Record<PrimitiveType, TypeMeta> = {
	bool: {
		size: 1,
		align: 1,
		load: (p, o) => i32Load8_u(p, o, ALIGN_1),
		store: (p, v, o) => i32Store8(p, v, o, ALIGN_1),
	},
	u8: {
		size: 1,
		align: 1,
		load: (p, o) => i32Load8_u(p, o, ALIGN_1),
		store: (p, v, o) => i32Store8(p, v, o, ALIGN_1),
	},
	i8: {
		size: 1,
		align: 1,
		load: (p, o) => i32Load8_s(p, o, ALIGN_1),
		store: (p, v, o) => i32Store8(p, v, o, ALIGN_1),
	},
	u16: {
		size: 2,
		align: 2,
		load: (p, o) => i32Load16_u(p, o, ALIGN_2),
		store: (p, v, o) => i32Store16(p, v, o, ALIGN_2),
	},
	i16: {
		size: 2,
		align: 2,
		load: (p, o) => i32Load16_s(p, o, ALIGN_2),
		store: (p, v, o) => i32Store16(p, v, o, ALIGN_2),
	},
	i32: {
		size: 4,
		align: 4,
		load: (p, o) => i32Load(p, o, ALIGN_4),
		store: (p, v, o) => i32Store(p, v, o, ALIGN_4),
	},
	u32: {
		size: 4,
		align: 4,
		load: (p, o) => i32Load(p, o, ALIGN_4),
		store: (p, v, o) => i32Store(p, v, o, ALIGN_4),
	},
	f32: {
		size: 4,
		align: 4,
		load: (p, o) => f32Load(p, o, ALIGN_4),
		store: (p, v, o) => f32Store(p, v, o, ALIGN_4),
	},
	i64: {
		size: 8,
		align: 8,
		load: (p, o) => i64Load(p, o, ALIGN_8),
		store: (p, v, o) => i64Store(p, v, o, ALIGN_8),
	},
	u64: {
		size: 8,
		align: 8,
		load: (p, o) => i64Load(p, o, ALIGN_8),
		store: (p, v, o) => i64Store(p, v, o, ALIGN_8),
	},
	f64: {
		size: 8,
		align: 8,
		load: (p, o) => f64Load(p, o, ALIGN_8),
		store: (p, v, o) => f64Store(p, v, o, ALIGN_8),
	},
};

export type FieldType = PrimitiveType | StructDef<any> | EnumDef<any>;

// ==========================================
// 2. Struct System
// ==========================================

type StructSchema = Record<string, FieldType>;

export type StructInstance<S extends StructSchema> = {
	[K in keyof S]: S[K] extends PrimitiveType
		? { load(): Node; store(val: Node): Node; ptr(): Node }
		: S[K] extends StructDef<infer InnerS>
		? StructInstance<InnerS> & { ptr(): Node }
		: S[K] extends EnumDef<infer InnerV>
		? EnumInstance<InnerV> & { ptr(): Node }
		: never;
} & {
	$ptr: Node;
};

export class StructDef<S extends StructSchema> {
	public readonly size: number;
	public readonly align: number;
	public readonly offsets: Record<keyof S, number>;
	public readonly schema: S;

	constructor(schema: S) {
		this.schema = schema;
		this.offsets = {} as any;

		let currentOffset = 0;
		let maxAlign = 1;

		for (const key in schema) {
			const type = schema[key]!;
			const meta = this.getTypeMeta(type);

			const padding = (meta.align - (currentOffset % meta.align)) % meta.align;
			currentOffset += padding;

			this.offsets[key] = currentOffset;
			currentOffset += meta.size;
			maxAlign = Math.max(maxAlign, meta.align);
		}

		const endPadding = (maxAlign - (currentOffset % maxAlign)) % maxAlign;
		this.size = currentOffset + endPadding;
		this.align = maxAlign;
	}

	private getTypeMeta(type: FieldType): { size: number; align: number } {
		if (typeof type === "string") return PRIMITIVES[type];
		if (type instanceof StructDef || type instanceof EnumDef)
			return { size: type.size, align: type.align };
		throw new Error(`Unknown type in struct: ${type}`);
	}

	public at(basePtr: Node): StructInstance<S> {
		const proxy: any = { $ptr: basePtr };

		for (const key in this.schema) {
			const type = this.schema[key];
			const offset = this.offsets[key];
			const getFieldPtr = () =>
				offset === 0 ? basePtr : i32Add(basePtr, i32Const(offset));

			if (typeof type === "string") {
				const meta = PRIMITIVES[type as keyof typeof PRIMITIVES];
				proxy[key] = {
					load: () => meta.load(basePtr, offset),
					store: (val: Node) => meta.store(basePtr, val, offset),
					ptr: getFieldPtr,
				};
			} else if (type instanceof StructDef) {
				const innerInstance = type.at(getFieldPtr());
				(innerInstance as any).ptr = getFieldPtr;
				proxy[key] = innerInstance;
			} else if (type instanceof EnumDef) {
				const innerInstance = type.at(getFieldPtr());
				(innerInstance as any).ptr = getFieldPtr;
				proxy[key] = innerInstance;
			}
		}

		return proxy as StructInstance<S>;
	}
}

export function Struct<S extends StructSchema>(schema: S) {
	return new StructDef(schema);
}

// ==========================================
// 3. Enum System
// ==========================================

type EnumVariants = Record<string, StructDef<any> | null>;

export interface EnumInstance<V extends EnumVariants> {
	tag(): Node;
	setTag(tagVal: number): Node;
	is(variantName: keyof V): Node;
	as<K extends keyof V>(
		variantName: K
	): V[K] extends StructDef<infer S> ? StructInstance<S> : void;
	$ptr: Node;
}

export class EnumDef<V extends EnumVariants> {
	public readonly size: number;
	public readonly align: number;
	public readonly tagOffset: number = 0;
	public readonly payloadOffset: number;
	public readonly variants: V;
	public readonly tagMap: Record<keyof V, number>;

	constructor(variants: V) {
		this.variants = variants;
		this.tagMap = {} as any;

		const TAG_SIZE = 4;
		const TAG_ALIGN = 4;

		let maxPayloadSize = 0;
		let maxPayloadAlign = 1;
		let tagCounter = 0;

		for (const key in variants) {
			this.tagMap[key] = tagCounter++;
			const variantDef = variants[key];
			if (variantDef) {
				maxPayloadSize = Math.max(maxPayloadSize, variantDef.size);
				maxPayloadAlign = Math.max(maxPayloadAlign, variantDef.align);
			}
		}

		// [FIX 1] Removed unused payloadStart variable
		const padding =
			(maxPayloadAlign - (TAG_SIZE % maxPayloadAlign)) % maxPayloadAlign;
		this.payloadOffset = TAG_SIZE + padding;

		this.size = this.payloadOffset + maxPayloadSize;
		this.align = Math.max(TAG_ALIGN, maxPayloadAlign);

		const endPadding = (this.align - (this.size % this.align)) % this.align;
		this.size += endPadding;
	}

	public at(basePtr: Node): EnumInstance<V> {
		// [FIX 2] Removed 'const self = this' alias.
		// Using arrow functions for methods to capture 'this' automatically.
		const instance: EnumInstance<V> = {
			$ptr: basePtr,

			tag: () => {
				return i32Load(basePtr, this.tagOffset, ALIGN_4);
			},

			setTag: (tagVal: number) => {
				return i32Store(basePtr, i32Const(tagVal), this.tagOffset, ALIGN_4);
			},

			is: (variantName: keyof V) => {
				const targetTag = this.tagMap[variantName];
				// Note: using this.tag() calls the arrow function above
				return i32Eq(
					i32Load(basePtr, this.tagOffset, ALIGN_4),
					i32Const(targetTag)
				);
			},

			as: <K extends keyof V>(variantName: K) => {
				const structDef = this.variants[variantName];
				if (!structDef) return undefined as any;

				const payloadPtr = i32Add(basePtr, i32Const(this.payloadOffset));
				return structDef.at(payloadPtr);
			},
		};

		// Register instance for match() to access EnumDef
		enumInstanceToDefMap.set(instance, this);

		return instance;
	}
}

export function Enum<V extends EnumVariants>(variants: V) {
	return new EnumDef(variants);
}

// ==========================================
// 4. Pattern Matching
// ==========================================

type MatchCases<V extends EnumVariants> = {
	[K in keyof V]?: (
		payload: V[K] extends StructDef<infer S> ? StructInstance<S> : void
	) => Node | Node[];
};

/**
 * Pattern matching using WASM br_table instruction.
 *
 * This implementation follows the WASM specification and Rust's compilation strategy:
 * - Uses br_table for O(1) dispatch based on enum tag
 * - Generates a jump table structure similar to Rust's match compilation
 *
 * WASM br_table semantics:
 * - br_table [l0, l1, ...] l_default pops an i32 index
 * - If index=0, branch to l0; index=1, branch to l1; etc.
 * - If index >= len, branch to l_default
 * - br jumps to the END of the target block (not the beginning)
 *
 * Generated structure (for 2 variants: Idle=0, Running=1):
 * ```wasm
 * (block $match_end (result T)
 *   (block $case_1           ;; depth 1 from br_table
 *     (block $case_0         ;; depth 2 from br_table
 *       (block $default      ;; depth 3 from br_table
 *         (br_table $case_0 $case_1 $default (tag))
 *       )
 *       ;; default case body (falls through after $default block ends)
 *       (br $match_end)
 *     )
 *     ;; case 0 body (Idle)
 *     (br $match_end)
 *   )
 *   ;; case 1 body (Running) - last case, falls through to match_end
 * )
 * ```
 */
export function match<V extends EnumVariants>(
	enumInst: EnumInstance<V>,
	cases: MatchCases<V>,
	defaultCase?: () => Node[],
	resultType?: ValueType
): Node {
	// Get the EnumDef from the instance to access tagMap
	const enumDef = getEnumDefFromInstance(enumInst);
	const variantNames = Object.keys(enumDef.variants);
	const maxTag = variantNames.length;

	// Build label names
	const caseLabels: string[] = [];
	for (let i = 0; i < maxTag; i++) {
		caseLabels.push(`case_${i}`);
	}
	const defaultLabel = "default";
	const endLabel = "match_end";

	// Map tag index to variant name
	const tagToVariant = new Map<number, string>();
	for (const [name, tag] of Object.entries(enumDef.tagMap)) {
		tagToVariant.set(tag as number, name);
	}

	// br_table labels: for index i, we want to jump to case_i block's end
	// The blocks are nested: $match_end > $case_{N-1} > ... > $case_0 > $default
	// So from br_table's perspective (inside $default):
	// - $default is depth 0
	// - $case_0 is depth 1
	// - $case_1 is depth 2
	// - ...
	// - $case_{N-1} is depth N
	// - $match_end is depth N+1
	const brTableLabels: string[] = [];
	for (let i = 0; i < maxTag; i++) {
		brTableLabels.push(caseLabels[i]!);
	}

	// Helper to get case body for a variant
	const getCaseBody = (tagIndex: number): Node[] => {
		const variantName = tagToVariant.get(tagIndex);
		const handler = variantName ? cases[variantName as keyof V] : undefined;

		if (handler) {
			const payload = enumInst.as(variantName as keyof V);
			const result = (handler as Function)(payload);
			return normalizeNodes(result);
		}
		// No handler - fall through to default behavior (empty body, will hit br to end)
		return [];
	};

	// Build nested blocks from inside out
	// Innermost: $default block with br_table
	let current: Node = block(
		defaultLabel,
		[brTable(brTableLabels, defaultLabel, enumInst.tag())],
		"void"
	);

	// After $default block ends, we're in the default case
	// Add default case body, then br to end
	const defaultBody = defaultCase ? normalizeNodes(defaultCase()) : [];
	current = block(
		caseLabels[0]!,
		[current, ...defaultBody, br(endLabel)],
		"void"
	);

	// Wrap with case blocks from case_0 to case_{N-1}
	for (let i = 0; i < maxTag; i++) {
		const caseBody = getCaseBody(i);
		const isLastCase = i === maxTag - 1;

		if (isLastCase) {
			// Last case - wrap with match_end, no br needed (falls through)
			current = block(endLabel, [current, ...caseBody], resultType);
		} else {
			// Not last case - wrap with next case label, add br to end
			current = block(
				caseLabels[i + 1]!,
				[current, ...caseBody, br(endLabel)],
				"void"
			);
		}
	}

	return current;
}

/**
 * Helper to normalize handler results to Node[]
 */
function normalizeNodes(result: Node | Node[]): Node[] {
	if (Array.isArray(result)) return result;
	return [result];
}

/**
 * Extract EnumDef from EnumInstance.
 * This is a workaround since EnumInstance doesn't directly expose the EnumDef.
 */
function getEnumDefFromInstance<V extends EnumVariants>(
	inst: EnumInstance<V>
): EnumDef<V> {
	// We need to access the EnumDef that created this instance
	// Since EnumInstance is created by EnumDef.at(), we need to store a reference
	// For now, we'll use a WeakMap to track this relationship
	const def = enumInstanceToDefMap.get(inst);
	if (!def) {
		throw new Error(
			"EnumInstance not registered. Make sure to use EnumDef.at() to create instances."
		);
	}
	return def as EnumDef<V>;
}

// WeakMap to track EnumInstance -> EnumDef relationship
const enumInstanceToDefMap = new WeakMap<EnumInstance<any>, EnumDef<any>>();

// ==========================================
// 5. Array / Slice Helper
// ==========================================

export function ArrayView<S extends StructSchema>(
	basePtr: Node,
	index: Node,
	structDef: StructDef<S>
): StructInstance<S> {
	// [FIX 3] Removed unused 'offset' variable (it was using i32Load incorrectly anyway)

	// Calculate offset: index * struct_size
	const itemOffset =
		typeof index === "object" && index.type === "const"
			? i32Const((index.value as number) * structDef.size)
			: i32Mul(index, i32Const(structDef.size));

	const ptr = i32Add(basePtr, itemOffset);
	return structDef.at(ptr);
}
