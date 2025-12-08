// src/dsl/autotune.ts

import { FuncNode, Node, v128Load, v128Store } from "./ast";

import { SIMD_SUPPORTED, getSimdAlignment } from "./simd";

// ==========================================
// 1. Configuration
// ==========================================

export interface VectorizationResult {
	func: FuncNode;
	width: number;
	success: boolean;
}

export interface AutoTuneOptions {
	targetType?: "i32" | "f32";
}

// Map Scalar Opcode -> Vector Opcode String
const SIMD_OP_MAP: Record<string, string> = {
	// i32 -> i32x4
	"i32.add": "i32x4.add",
	"i32.sub": "i32x4.sub",
	"i32.mul": "i32x4.mul",

	// f32 -> f32x4
	"f32.add": "f32x4.add",
	"f32.sub": "f32x4.sub",
	"f32.mul": "f32x4.mul",
	"f32.div": "f32x4.div",
	"f32.min": "f32x4.min",
	"f32.max": "f32x4.max",

	// Bitwise (v128 uses specific opcodes)
	"i32.and": "v128.and",
	"i32.or": "v128.or",
	"i32.xor": "v128.xor",
	"i32.not": "v128.not",
};

// ==========================================
// 2. Main Logic
// ==========================================

export function autoVectorize(
	scalarFunc: FuncNode,
	options: AutoTuneOptions = {}
): VectorizationResult {
	if (!SIMD_SUPPORTED) {
		return { func: scalarFunc, width: 1, success: false };
	}

	const type = options.targetType || "f32";

	// 1. Check if vectorizable
	if (!hasVectorizableOps(scalarFunc, type)) {
		return { func: scalarFunc, width: 1, success: false };
	}

	// 2. Transform Body
	const newBody = transformNodes(scalarFunc.children, type);

	const newFunc: FuncNode = {
		...scalarFunc,
		name: `${scalarFunc.name}_simd`,
		children: newBody,
	};

	return { func: newFunc, width: 4, success: true };
}

// ==========================================
// 3. Transformation Engine
// ==========================================

function transformNodes(nodes: Node[], targetType: string): Node[] {
	return nodes.map((n) => transformNode(n, targetType));
}

function transformNode(node: Node, type: string): Node {
	const op = node.op || node.type;

	// A. Memory Loads
	if (op === `${type}.load`) {
		const ptr = node.children
			? transformNode(node.children[0]!, type)
			: undefined;

		if (!ptr) return node;

		return v128Load(ptr, node.offset, getSimdAlignment(node.align));
	}

	// B. Memory Stores
	if (op === `${type}.store`) {
		const ptr = node.children
			? transformNode(node.children[0]!, type)
			: undefined;
		const val = node.children
			? transformNode(node.children[1]!, type)
			: undefined;

		if (!ptr || !val) return node;

		return v128Store(ptr, val, node.offset, getSimdAlignment(node.align));
	}

	// C. Arithmetic & Bitwise
	const vecOpStr = SIMD_OP_MAP[op];
	if (vecOpStr) {
		// HEURISTIC: Loop Stride Adjustment
		// If we encounter 'i32.add(x, 1)', it's likely a loop increment or pointer step.
		// We upgrade 'const 1' to 'const 4' to handle SIMD width.
		if (op === "i32.add" && node.children && node.children.length === 2) {
			const right = node.children[1];
			if (right?.type === "const" && right.value === 1) {
				return {
					type: "binop",
					op: "i32.add", // Keep scalar add for the index
					children: [
						transformNode(node.children[0]!, type),
						{ ...right, value: 4 }, // Upgrade stride
					],
				};
			}
		}

		if (type === "f32" && op.startsWith("i32")) {
			// Skip pointer arithmetic (i32.add) in float mode (unless matched above)
			return node;
		}

		return {
			type: node.type,
			op: vecOpStr,
			children: node.children ? transformNodes(node.children, type) : [],
		};
	}

	// D. Constants (Splat)
	if (node.type === "const" && node.valueType === type) {
		const splatOpStr = type === "i32" ? "i32x4.splat" : "f32x4.splat";
		return {
			type: "unop",
			op: splatOpStr,
			children: [node],
		};
	}

	// E. Control Flow (Recurse)
	if (node.children) {
		return {
			...node,
			children: transformNodes(node.children, type),
		};
	}

	// F. Fallback
	return node;
}

// ==========================================
// 4. Analysis Helpers
// ==========================================

function hasVectorizableOps(func: FuncNode, type: string): boolean {
	let found = false;
	const search = (nodes: Node[]) => {
		for (const n of nodes) {
			const op = n.op || n.type;
			if (op.startsWith(type) && SIMD_OP_MAP[op]) {
				found = true;
			}
			if (op === `${type}.load` || op === `${type}.store`) {
				found = true;
			}
			if (found) return;
			if (n.children) search(n.children);
		}
	};
	if (func.children) search(func.children);
	return found;
}
