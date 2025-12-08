import { FuncNode, ModuleNode, Node, f32Const, i32Const } from "./ast";

// ==========================================
// 1. Pass Manager
// ==========================================

export interface OptimizeOptions {
	level: 0 | 1 | 2 | 3; // O0, O1, O2, O3
	unrollFactor?: number; // For loops
}

// export function optimize(func: FuncNode, options: OptimizeOptions): FuncNode {
// 	if (options.level === 0) return func;

// 	let currentFunc = func;
// 	let changed = true;
// 	let passCount = 0;
// 	// 多次迭代直到AST稳定 (Fixed-point iteration)
// 	const MAX_PASSES = 10;

// 	while (changed && passCount < MAX_PASSES) {
// 		const snapshot = JSON.stringify(currentFunc);

// 		// Pass 1: Constant Folding & Propagation
// 		currentFunc = runPass(currentFunc, constantFoldingPass);

// 		// Pass 2: Algebraic Simplification (Peephole)
// 		if (options.level >= 2) {
// 			currentFunc = runPass(currentFunc, peepholePass);
// 		}

// 		// Pass 3: Dead Code Elimination
// 		if (options.level >= 2) {
// 			currentFunc = runPass(currentFunc, dcePass);
// 		}

// 		// Pass 4: Loop Unrolling (Only once usually, but here we keep simple)
// 		// Note: Loop unrolling usually happens once structurally, not iteratively

// 		changed = JSON.stringify(currentFunc) !== snapshot;
// 		passCount++;
// 	}

// 	// O3 Specific: Loop Unrolling
// 	if (options.level >= 3) {
// 		currentFunc = runPass(currentFunc, (n) =>
// 			loopUnrollPass(n, options.unrollFactor || 4)
// 		);
// 		// Run folding again after unrolling to clean up index math
// 		currentFunc = runPass(currentFunc, constantFoldingPass);
// 	}

// 	return currentFunc;
// }

export function optimize<T extends Node>(node: T, options: OptimizeOptions): T {
	if (options.level === 0) return node;

	// [FIX] 如果是 Module，递归优化其子 Function
	if (node.type === "module") {
		const moduleNode = node as unknown as ModuleNode;
		const newChildren = moduleNode.children.map((child) => {
			if (child.type === "func") {
				return optimize(child as FuncNode, options);
			}
			return child;
		});
		return { ...moduleNode, children: newChildren } as unknown as T;
	}

	// 如果不是 FuncNode (且不是 Module)，直接返回
	if (node.type !== "func") return node;

	let currentFunc = node as unknown as FuncNode;
	let changed = true;
	let passCount = 0;
	const MAX_PASSES = 10;

	while (changed && passCount < MAX_PASSES) {
		const snapshot = JSON.stringify(currentFunc);
		currentFunc = runPass(currentFunc, constantFoldingPass);
		if (options.level >= 2) {
			currentFunc = runPass(currentFunc, peepholePass);
			currentFunc = runPass(currentFunc, dcePass);
		}
		changed = JSON.stringify(currentFunc) !== snapshot;
		passCount++;
	}

	if (options.level >= 3) {
		currentFunc = runPass(currentFunc, (n) =>
			loopUnrollPass(n, options.unrollFactor || 4)
		);
		currentFunc = runPass(currentFunc, constantFoldingPass);
	}

	return currentFunc as unknown as T;
}

// Helper to traverse AST
function runPass(node: Node | FuncNode, visitor: (n: Node) => Node): any {
	// Transform children first (bottom-up)
	let newChildren: Node[] | undefined;

	if (node.children) {
		newChildren = node.children.map((c) => runPass(c, visitor));
	}

	// Handle specific structures with nested arrays
	let newConsequent: Node[] | undefined;
	if (node.consequent) {
		newConsequent = node.consequent.map((c) => runPass(c, visitor));
	}
	let newAlternate: Node[] | undefined;
	if (node.alternate) {
		newAlternate = node.alternate.map((c) => runPass(c, visitor));
	}

	const newNode = { ...node };
	if (newChildren) newNode.children = newChildren;
	if (newConsequent) newNode.consequent = newConsequent;
	if (newAlternate) newNode.alternate = newAlternate;

	return visitor(newNode);
}

// ==========================================
// 2. Constant Folding (常量折叠)
// ==========================================

function constantFoldingPass(node: Node): Node {
	// Only fold if we have an OP and children are CONST
	if (!node.children || node.children.length === 0) return node;

	// Binary Ops
	if (node.children.length === 2) {
		const left = node.children[0];
		const right = node.children[1];

		if (left!.type === "const" && right!.type === "const") {
			const lVal = Number(left!.value);
			const rVal = Number(right!.value);
			const op = node.op || node.type;

			// i32 Math
			if (op === "i32.add") return i32Const(lVal + rVal);
			if (op === "i32.sub") return i32Const(lVal - rVal);
			if (op === "i32.mul") return i32Const(Math.imul(lVal, rVal));
			if (op === "i32.div_s" && rVal !== 0) return i32Const((lVal / rVal) | 0);
			if (op === "i32.shl") return i32Const(lVal << rVal);
			if (op === "i32.shr_s") return i32Const(lVal >> rVal);

			// f32 Math
			if (op === "f32.add") return f32Const(lVal + rVal);
			if (op === "f32.sub") return f32Const(lVal - rVal);
			if (op === "f32.mul") return f32Const(lVal * rVal);
			if (op === "f32.div") return f32Const(lVal / rVal);
		}
	}

	return node;
}

// ==========================================
// 3. Algebraic Simplification (代数简化)
// ==========================================

function peepholePass(node: Node): Node {
	if (!node.children || node.children.length !== 2) return node;
	const op = node.op || node.type;
	const left = node.children[0];
	const right = node.children[1];

	const isConst = (n: Node, v: number) =>
		n.type === "const" && Number(n.value) === v;

	// x + 0 = x
	if (op === "i32.add" || op === "f32.add") {
		if (isConst(right!, 0)) return left!;
		if (isConst(left!, 0)) return right!;
	}

	// x - 0 = x
	if ((op === "i32.sub" || op === "f32.sub") && isConst(right!, 0)) {
		return left!;
	}

	// x * 1 = x
	if (op === "i32.mul" || op === "f32.mul") {
		if (isConst(right!, 1)) return left!;
		if (isConst(left!, 1)) return right!;
	}

	// x * 0 = 0
	// Note: Be careful with floats (NaN/Inf), strictly safe for integers
	if (op === "i32.mul") {
		if (isConst(right!, 0) || isConst(left!, 0)) return i32Const(0);
	}

	// x << 0 = x
	if (
		(op === "i32.shl" || op === "i32.shr_s" || op === "i32.shr_u") &&
		isConst(right!, 0)
	) {
		return left!;
	}

	return node;
}

// ==========================================
// 4. Dead Code Elimination (死代码消除)
// ==========================================

function dcePass(node: Node): Node {
	// Structural DCE: Removing code after Unreachable/Return/Br in a Block
	if (node.type === "block" || node.type === "loop" || node.type === "func") {
		const newChildren: Node[] = [];
		let dead = false;

		for (const child of node.children || []) {
			if (dead) continue;
			newChildren.push(child);
			if (
				["return", "br", "br_if", "unreachable", "br_table"].includes(
					child.type
				)
			) {
				// br_if doesn't kill control flow unconditionally, strictly speaking
				if (child.type !== "br_if") {
					dead = true;
				}
			}
		}

		if (newChildren.length !== (node.children?.length || 0)) {
			return { ...node, children: newChildren };
		}
	}
	return node;
}

// ==========================================
// 5. Loop Unrolling (循环展开 - The Big Gun)
// ==========================================

/**
 * A very specific unroller that targets the canonical "for loop" pattern
 * generated by this DSL.
 * Pattern:
 * loop "top"
 *   br_if "out" (i >= N)
 *   ... body ...
 *   i = i + 1
 *   br "top"
 */
function loopUnrollPass(node: Node, factor: number): Node {
	if (node.type !== "loop" || !node.children) return node;

	// 1. Identification: Look for increment at the end
	const body = node.children;
	if (body.length < 3) return node; // Need at least Check, Body, Inc, Br

	const lastNode = body[body.length - 1]; // br "top"
	const incNode = body[body.length - 2]; // local.set i (i + step)

	if (!incNode || incNode.type !== "local.set") return node;

	const adder = incNode.children?.[0];
	if (!adder || adder.type !== "binop" || adder.op !== "i32.add") return node;

	// Check step constant
	const step = adder.children?.[1];
	if (!step || step.type !== "const") return node;

	const stepVal = Number(step.value);
	const loopVar = incNode.name!;

	// 2. Unrolling Strategy
	// Structure: [Check, ...RealBody..., Increment, Br]
	const checkNode = body[0];
	// Simple check: assume check is first.
	if (checkNode!.type !== "br_if") return node;

	// Extract the "Real Work" part (everything between Check and Increment)
	const realBody = body.slice(1, body.length - 2);

	const unrolledBody: Node[] = [];

	// Push the loop condition check (once at the top)
	unrolledBody.push(checkNode!);

	// Helper to generate increment node
	const makeIncrement = () =>
		({
			type: "local.set",
			name: loopVar,
			children: [
				{
					type: "binop",
					op: "i32.add",
					children: [
						{ type: "local.get", name: loopVar },
						{ type: "const", valueType: "i32", value: stepVal },
					],
				},
			],
		} as Node);

	// Generate N copies
	for (let k = 0; k < factor; k++) {
		// Clone the real body logic
		const chunk = JSON.parse(JSON.stringify(realBody)) as Node[];

		// Strategy: Interleaved Unrolling
		// Iter 0: Body
		// Iter 1: Inc, Body
		// Iter 2: Inc, Body
		// ...

		if (k > 0) {
			// 在执行后续的 body 之前，必须先更新索引 i
			unrolledBody.push(makeIncrement());
		}

		unrolledBody.push(...chunk);
	}

	// Final Increment for the next loop iteration
	// The original loop structure had an increment at the end.
	// Since we unrolled 'factor' times, we have injected (factor-1) increments above.
	// We need one last increment to close the cycle for the *next* macro-iteration.
	unrolledBody.push(makeIncrement());

	// Jump back to top
	unrolledBody.push(lastNode!);

	return { ...node, children: unrolledBody };
}
