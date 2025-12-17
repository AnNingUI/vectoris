// src/dsl/ast.ts

// ==========================================
// 1. Type Definitions
// ==========================================

export const ValueTypes = {
	i32: "i32",
	i64: "i64",
	f32: "f32",
	f64: "f64",
	v128: "v128",
	void: "void",
	func: "func",
	extern: "extern",
} as const;

export type ValueType = keyof typeof ValueTypes;

export type NodeType =
	// Structure
	| "module"
	| "func"
	| "import"
	| "export"
	| "param"
	| "result"
	| "local"
	| "global"
	| "table"
	| "memory"
	| "data"

	// Control Flow
	| "block"
	| "loop"
	| "if"
	| "br"
	| "br_if"
	| "br_table"
	| "return"
	| "call"
	| "call_indirect"
	| "nop"
	| "unreachable"
	| "drop"
	| "select"

	// Variable Access
	| "local.get"
	| "local.set"
	| "local.tee"
	| "global.get"
	| "global.set"

	// Memory Access
	| "i32.load"
	| "i64.load"
	| "f32.load"
	| "f64.load"
	| "i32.load8_s"
	| "i32.load8_u"
	| "i32.load16_s"
	| "i32.load16_u"
	| "i64.load8_s"
	| "i64.load8_u"
	| "i64.load16_s"
	| "i64.load16_u"
	| "i64.load32_s"
	| "i64.load32_u"
	| "i32.store"
	| "i64.store"
	| "f32.store"
	| "f64.store"
	| "i32.store8"
	| "i32.store16"
	| "i64.store8"
	| "i64.store16"
	| "i64.store32"
	| "memory.size"
	| "memory.grow"
	| "memory.copy"
	| "memory.fill"
	| "memory.init"
	| "data.drop"

	// Constants
	| "const"

	// Numerical Operations (Binary/Unary are grouped in AST but distiguished by 'op' string)
	| "binop"
	| "unop"

	// Atomics
	| "atomic.notify"
	| "atomic.wait"
	| "atomic.fence"
	| "i32.atomic.load"
	| "i64.atomic.load"
	| "i32.atomic.load8_u"
	| "i32.atomic.load16_u"
	| "i64.atomic.load8_u"
	| "i64.atomic.load16_u"
	| "i64.atomic.load32_u"
	| "i32.atomic.store"
	| "i64.atomic.store"
	| "i32.atomic.store8"
	| "i32.atomic.store16"
	| "i64.atomic.store8"
	| "i64.atomic.store16"
	| "i64.atomic.store32"
	| "i32.atomic.rmw.add"
	| "i64.atomic.rmw.add" // ... and other RMW ops (sub, and, or, xor, xchg, cmpxchg)
	| string; // Allow fallback for specific ops

export interface BaseNode {
	type: NodeType;
	children?: Node[];

	// Metadata / Identifiers
	name?: string;

	// Values & Types
	value?: number | bigint | string | number[] | string[]; // For consts, br_table labels, etc.
	valueType?: ValueType;

	// Memory / Struct args
	offset?: number;
	align?: number;

	// Function specific
	params?: ParamNode[];
	results?: ResultNode[];
	locals?: LocalNode[];

	// Operation specific
	op?: string; // For binop/unop e.g., "i32.add"

	// Module specific
	moduleName?: string;
	fieldName?: string;
	desc?: any;

	// If/Else
	test?: Node; // condition (usually first child, but explicit field helps)
	consequent?: Node[];
	alternate?: Node[];
}

export type Node = BaseNode;

export interface ModuleNode extends Node {
	type: "module";
	children: Node[];
}
export interface FuncNode extends Node {
	type: "func";
	children: Node[];
}
export interface ParamNode extends Node {
	type: "param";
	valueType: ValueType;
}
export interface ResultNode extends Node {
	type: "result";
	valueType: ValueType;
}
export interface LocalNode extends Node {
	type: "local";
	valueType: ValueType;
}

// ==========================================
// 2. Structural Helpers
// ==========================================

export function module(name?: string, children: Node[] = []): ModuleNode {
	return { type: "module", name, children };
}

export function func(
	name: string,
	params: ParamNode[] = [],
	results: ResultNode[] = [],
	locals: LocalNode[] = [],
	body: Node[] = []
): FuncNode {
	return { type: "func", name, params, results, locals, children: body };
}

export function importMemory(
	moduleName: string,
	fieldName: string,
	limits: { min: number; max?: number; shared?: boolean }
): Node {
	return {
		type: "import",
		moduleName,
		fieldName,
		desc: { kind: "memory", limits },
	};
}

export function exportFunc(name: string): Node {
	// Note: In our emitter logic, exports are usually derived from func names,
	// but explicit export node can be useful for re-exporting.
	return { type: "export", name };
}

export function param(name?: string, valueType: ValueType = "i32"): ParamNode {
	return { type: "param", name, valueType };
}
export function result(valueType: ValueType = "i32"): ResultNode {
	return { type: "result", valueType };
}
export function local(name?: string, valueType: ValueType = "i32"): LocalNode {
	return { type: "local", name, valueType };
}

// ==========================================
// 3. Control Flow
// ==========================================

export function block(
	label: string | undefined,
	children: Node[],
	resultType?: ValueType
): Node {
	return {
		type: "block",
		name: label,
		children,
		valueType: resultType || "void",
	};
}
export function loop(
	label: string | undefined,
	children: Node[],
	resultType?: ValueType
): Node {
	return {
		type: "loop",
		name: label,
		children,
		valueType: resultType || "void",
	};
}
export function ifNode(
	test: Node,
	thenBranch: Node[],
	elseBranch?: Node[],
	resultType?: ValueType
): Node {
	return {
		type: "if",
		children: [test],
		consequent: thenBranch,
		alternate: elseBranch,
		valueType: resultType || "void",
	};
}
export function br(label: string): Node {
	return { type: "br", name: label, value: label };
}
export function brIf(label: string, condition: Node): Node {
	return { type: "br_if", name: label, children: [condition], value: label };
}

/**
 * br_table - Multi-way branch instruction
 * @param labels - Array of label names for each case (index 0, 1, 2, ...)
 * @param defaultLabel - Default label when index is out of bounds
 * @param index - The index value node (i32) to branch on
 */
export function brTable(
	labels: string[],
	defaultLabel: string,
	index: Node
): Node {
	return {
		type: "br_table",
		value: labels as string[], // Store labels array
		name: defaultLabel, // Store default label
		children: [index], // Index expression
	};
}
export function call(name: string, args: Node[] = []): Node {
	return { type: "call", name, children: args };
}
export function callIndirect(
	typeIdx: number,
	tableIdx: number,
	args: Node[],
	targetIdx: Node
): Node {
	return {
		type: "call_indirect",
		value: typeIdx,
		offset: tableIdx,
		children: [...args, targetIdx],
	};
}
export function returnNode(value?: Node): Node {
	return { type: "return", children: value ? [value] : [] };
}
export function unreachable(): Node {
	return { type: "unreachable" };
}
export function nop(): Node {
	return { type: "nop" };
}
export function drop(value: Node): Node {
	return { type: "drop", children: [value] };
}
export function select(condition: Node, trueVal: Node, falseVal: Node): Node {
	return { type: "select", children: [trueVal, falseVal, condition] };
}

// ==========================================
// 4. Variables & Constants
// ==========================================

export function constVal(valueType: ValueType, value: number | bigint): Node {
	return { type: "const", valueType, value };
}
export function i32Const(v: number): Node {
	return constVal("i32", v);
}
export function i64Const(v: number | bigint): Node {
	return constVal("i64", v);
}
export function f32Const(v: number): Node {
	return constVal("f32", v);
}
export function f64Const(v: number): Node {
	return constVal("f64", v);
}

export function localGet(name: string): Node {
	return { type: "local.get", name };
}
export function localSet(name: string, value: Node): Node {
	return { type: "local.set", name, children: [value] };
}
export function localTee(name: string, value: Node): Node {
	return { type: "local.tee", name, children: [value] };
}
export function globalGet(name: string): Node {
	return { type: "global.get", name };
}
export function globalSet(name: string, value: Node): Node {
	return { type: "global.set", name, children: [value] };
}

// ==========================================
// 5. Memory Operations
// ==========================================

function memOp(
	type: NodeType,
	offset: number,
	align: number,
	index?: Node,
	value?: Node
): Node {
	const children = [];
	if (index) children.push(index);
	if (value) children.push(value);
	return { type, offset, align, children };
}

// Loads
export const i32Load = (idx: Node, o = 0, a = 2) =>
	memOp("i32.load", o, a, idx);
export const i64Load = (idx: Node, o = 0, a = 3) =>
	memOp("i64.load", o, a, idx);
export const f32Load = (idx: Node, o = 0, a = 2) =>
	memOp("f32.load", o, a, idx);
export const f64Load = (idx: Node, o = 0, a = 3) =>
	memOp("f64.load", o, a, idx);
export const i32Load8_s = (idx: Node, o = 0, a = 0) =>
	memOp("i32.load8_s", o, a, idx);
export const i32Load8_u = (idx: Node, o = 0, a = 0) =>
	memOp("i32.load8_u", o, a, idx);
export const i32Load16_s = (idx: Node, o = 0, a = 1) =>
	memOp("i32.load16_s", o, a, idx);
export const i32Load16_u = (idx: Node, o = 0, a = 1) =>
	memOp("i32.load16_u", o, a, idx);

// Stores
export const i32Store = (idx: Node, val: Node, o = 0, a = 2) =>
	memOp("i32.store", o, a, idx, val);
export const i64Store = (idx: Node, val: Node, o = 0, a = 3) =>
	memOp("i64.store", o, a, idx, val);
export const f32Store = (idx: Node, val: Node, o = 0, a = 2) =>
	memOp("f32.store", o, a, idx, val);
export const f64Store = (idx: Node, val: Node, o = 0, a = 3) =>
	memOp("f64.store", o, a, idx, val);
export const i32Store8 = (idx: Node, val: Node, o = 0, a = 0) =>
	memOp("i32.store8", o, a, idx, val);
export const i32Store16 = (idx: Node, val: Node, o = 0, a = 1) =>
	memOp("i32.store16", o, a, idx, val);

// Bulk Memory
export const memorySize = (): Node => ({ type: "memory.size" });
export const memoryGrow = (pages: Node): Node => ({
	type: "memory.grow",
	children: [pages],
});
export const memoryCopy = (dest: Node, src: Node, size: Node): Node => ({
	type: "memory.copy",
	children: [dest, src, size],
});
export const memoryFill = (dest: Node, val: Node, size: Node): Node => ({
	type: "memory.fill",
	children: [dest, val, size],
});

// ==========================================
// 6. Arithmetic & Bitwise Operations
// ==========================================

const bin =
	(op: string) =>
	(l: Node, r: Node): Node => ({ type: "binop", op, children: [l, r] });
const un =
	(op: string) =>
	(v: Node): Node => ({ type: "unop", op, children: [v] });

// i32
export const i32Add = bin("i32.add");
export const i32Sub = bin("i32.sub");
export const i32Mul = bin("i32.mul");
export const i32DivS = bin("i32.div_s");
export const i32DivU = bin("i32.div_u");
export const i32RemS = bin("i32.rem_s");
export const i32RemU = bin("i32.rem_u");
export const i32And = bin("i32.and");
export const i32Or = bin("i32.or");
export const i32Xor = bin("i32.xor");
export const i32Shl = bin("i32.shl");
export const i32ShrS = bin("i32.shr_s");
export const i32ShrU = bin("i32.shr_u");
export const i32Eqz = un("i32.eqz");
export const i32Eq = bin("i32.eq");
export const i32Ne = bin("i32.ne");
export const i32LtS = bin("i32.lt_s");
export const i32LtU = bin("i32.lt_u");
export const i32GtS = bin("i32.gt_s");
export const i32GtU = bin("i32.gt_u");
export const i32LeS = bin("i32.le_s");
export const i32LeU = bin("i32.le_u");
export const i32GeS = bin("i32.ge_s");
export const i32GeU = bin("i32.ge_u");
export const i32Clz = un("i32.clz");
export const i32Ctz = un("i32.ctz");
export const i32Popcnt = un("i32.popcnt");

// i64
export const i64Add = bin("i64.add");
export const i64Sub = bin("i64.sub");
export const i64Mul = bin("i64.mul");
export const i64DivS = bin("i64.div_s");
export const i64DivU = bin("i64.div_u");
export const i64RemS = bin("i64.rem_s");
export const i64RemU = bin("i64.rem_u");
export const i64And = bin("i64.and");
export const i64Or = bin("i64.or");
export const i64Xor = bin("i64.xor");
export const i64Shl = bin("i64.shl");
export const i64ShrS = bin("i64.shr_s");
export const i64ShrU = bin("i64.shr_u");
export const i64Eqz = un("i64.eqz");
export const i64Eq = bin("i64.eq");
export const i64Ne = bin("i64.ne");
export const i64LtS = bin("i64.lt_s");
export const i64LtU = bin("i64.lt_u");
export const i64GtS = bin("i64.gt_s");
export const i64GtU = bin("i64.gt_u");
export const i64LeS = bin("i64.le_s");
export const i64LeU = bin("i64.le_u");
export const i64GeS = bin("i64.ge_s");
export const i64GeU = bin("i64.ge_u");

// f32
export const f32Abs = un("f32.abs");
export const f32Neg = un("f32.neg");
export const f32Ceil = un("f32.ceil");
export const f32Floor = un("f32.floor");
export const f32Trunc = un("f32.trunc");
export const f32Nearest = un("f32.nearest");
export const f32Sqrt = un("f32.sqrt");
export const f32Add = bin("f32.add");
export const f32Sub = bin("f32.sub");
export const f32Mul = bin("f32.mul");
export const f32Div = bin("f32.div");
export const f32Min = bin("f32.min");
export const f32Max = bin("f32.max");
export const f32Copysign = bin("f32.copysign");
export const f32Eq = bin("f32.eq");
export const f32Ne = bin("f32.ne");
export const f32Lt = bin("f32.lt");
export const f32Gt = bin("f32.gt");
export const f32Le = bin("f32.le");
export const f32Ge = bin("f32.ge");

// f64
export const f64Abs = un("f64.abs");
export const f64Neg = un("f64.neg");
export const f64Sqrt = un("f64.sqrt");
export const f64Add = bin("f64.add");
export const f64Sub = bin("f64.sub");
export const f64Mul = bin("f64.mul");
export const f64Div = bin("f64.div");
export const f64Min = bin("f64.min");
export const f64Max = bin("f64.max");
export const f64Eq = bin("f64.eq");
export const f64Ne = bin("f64.ne");
export const f64Lt = bin("f64.lt");
export const f64Gt = bin("f64.gt");
export const f64Le = bin("f64.le");
export const f64Ge = bin("f64.ge");

// Conversions
export const i32WrapI64 = un("i32.wrap_i64");
export const i32TruncF32S = un("i32.trunc_f32_s");
export const i32TruncF32U = un("i32.trunc_f32_u");
export const i32TruncF64S = un("i32.trunc_f64_s");
export const i32TruncF64U = un("i32.trunc_f64_u");
export const i64ExtendI32S = un("i64.extend_i32_s");
export const i64ExtendI32U = un("i64.extend_i32_u");
export const i64TruncF32S = un("i64.trunc_f32_s");
export const i64TruncF32U = un("i64.trunc_f32_u");
export const i64TruncF64S = un("i64.trunc_f64_s");
export const i64TruncF64U = un("i64.trunc_f64_u");
export const f32ConvertI32S = un("f32.convert_i32_s");
export const f32ConvertI32U = un("f32.convert_i32_u");
export const f32ConvertI64S = un("f32.convert_i64_s");
export const f32ConvertI64U = un("f32.convert_i64_u");
export const f32DemoteF64 = un("f32.demote_f64");
export const f64ConvertI32S = un("f64.convert_i32_s");
export const f64ConvertI32U = un("f64.convert_i32_u");
export const f64ConvertI64S = un("f64.convert_i64_s");
export const f64ConvertI64U = un("f64.convert_i64_u");
export const f64PromoteF32 = un("f64.promote_f32");

// ==========================================
// 7. SIMD (v128)
// ==========================================

export const v128Load = (idx: Node, o = 0, a = 4) =>
	memOp("v128.load", o, a, idx);
export const v128Store = (idx: Node, val: Node, o = 0, a = 4) =>
	memOp("v128.store", o, a, idx, val);

export const v128Const = (bytes: number[]): Node => ({
	type: "v128.const",
	value: bytes,
});

export const i8x16Splat = un("i8x16.splat");
export const i16x8Splat = un("i16x8.splat");
export const i32x4Splat = un("i32x4.splat");
export const i64x2Splat = un("i64x2.splat");
export const f32x4Splat = un("f32x4.splat");
export const f64x2Splat = un("f64x2.splat");

export const i32x4ExtractLane = (v: Node, lane: number): Node => ({
	type: "i32x4.extract_lane",
	value: lane,
	children: [v],
});
export const i32x4ReplaceLane = (v: Node, val: Node, lane: number): Node => ({
	type: "i32x4.replace_lane",
	value: lane,
	children: [v, val],
});
export const f32x4ExtractLane = (v: Node, lane: number): Node => ({
	type: "f32x4.extract_lane",
	value: lane,
	children: [v],
});
export const f32x4ReplaceLane = (v: Node, val: Node, lane: number): Node => ({
	type: "f32x4.replace_lane",
	value: lane,
	children: [v, val],
});

export const i32x4Add = bin("i32x4.add");
export const i32x4Sub = bin("i32x4.sub");
export const i32x4Mul = bin("i32x4.mul");
export const i32x4MinS = bin("i32x4.min_s");
export const i32x4MaxS = bin("i32x4.max_s");
export const f32x4Add = bin("f32x4.add");
export const f32x4Sub = bin("f32x4.sub");
export const f32x4Mul = bin("f32x4.mul");
export const f32x4Div = bin("f32x4.div");
export const f32x4Min = bin("f32x4.min");
export const f32x4Max = bin("f32x4.max");

// ==========================================
// 8. Atomics
// ==========================================

export const atomicNotify = (addr: Node, count: Node, o = 0, a = 2): Node => ({
	type: "atomic.notify",
	offset: o,
	align: a,
	children: [addr, count],
});

export const atomicWait32 = (
	addr: Node,
	expect: Node,
	timeout: Node,
	o = 0,
	a = 2
): Node => ({
	type: "atomic.wait",
	op: "i32",
	offset: o,
	align: a,
	children: [addr, expect, timeout],
});

export const atomicFence = (): Node => ({ type: "atomic.fence" });

export const i32AtomicLoad = (idx: Node, o = 0, a = 2) =>
	memOp("i32.atomic.load", o, a, idx);
export const i64AtomicLoad = (idx: Node, o = 0, a = 3) =>
	memOp("i64.atomic.load", o, a, idx);
export const i32AtomicStore = (idx: Node, val: Node, o = 0, a = 2) =>
	memOp("i32.atomic.store", o, a, idx, val);
export const i64AtomicStore = (idx: Node, val: Node, o = 0, a = 3) =>
	memOp("i64.atomic.store", o, a, idx, val);

const atomicRmw =
	(op: string) =>
	(idx: Node, val: Node, o = 0, a = 2): Node => ({
		type: "binop",
		op,
		offset: o,
		align: a,
		children: [idx, val],
	});

export const i32AtomicAdd = atomicRmw("i32.atomic.rmw.add");
export const i32AtomicSub = atomicRmw("i32.atomic.rmw.sub");
export const i32AtomicAnd = atomicRmw("i32.atomic.rmw.and");
export const i32AtomicOr = atomicRmw("i32.atomic.rmw.or");
export const i32AtomicXor = atomicRmw("i32.atomic.rmw.xor");
export const i32AtomicXchg = atomicRmw("i32.atomic.rmw.xchg");

export const i32AtomicCmpxchg = (
	idx: Node,
	expected: Node,
	replacement: Node,
	o = 0,
	a = 2
): Node => ({
	type: "unop",
	op: "i32.atomic.rmw.cmpxchg",
	offset: o,
	align: a,
	children: [idx, expected, replacement],
});
