// src/dsl/emit.ts

import { FuncNode, ModuleNode, Node } from "./ast";
import {
	BinaryWriter,
	KIND,
	OPCODES,
	SECTION,
	VAL_TYPE,
} from "./binary_encoding";

// ==========================================
// 1. Compiler Context & Helpers
// ==========================================

class CompilerContext {
	funcIndexMap = new Map<string, number>();
	globalIndexMap = new Map<string, number>();
	memIndexMap = new Map<string, number>();

	typeSignatures: string[] = [];
	funcTypeIndices: number[] = [];

	importFuncCount = 0;
	importGlobalCount = 0;
	importMemCount = 0;

	addType(params: string[], results: string[]): number {
		const key = `${params.join(",")}|${results.join(",")}`;
		let idx = this.typeSignatures.indexOf(key);
		if (idx === -1) {
			idx = this.typeSignatures.length;
			this.typeSignatures.push(key);
		}
		return idx;
	}
}

class FunctionContext {
	localIndexMap = new Map<string, number>();
	labelStack: string[] = [];

	constructor(funcNode: FuncNode) {
		let idx = 0;
		(funcNode.params || []).forEach((p) => {
			if (p.name) this.localIndexMap.set(p.name, idx);
			idx++;
		});
		(funcNode.locals || []).forEach((l) => {
			if (l.name) this.localIndexMap.set(l.name, idx);
			idx++;
		});
	}

	pushLabel(name?: string) {
		this.labelStack.push(name || "");
	}

	popLabel() {
		this.labelStack.pop();
	}

	getRelativeDepth(labelName: string): number {
		for (let i = this.labelStack.length - 1; i >= 0; i--) {
			if (this.labelStack[i] === labelName) {
				return this.labelStack.length - 1 - i;
			}
		}
		if (/^\d+$/.test(labelName)) return parseInt(labelName);
		throw new Error(`Unknown label: ${labelName}`);
	}
}

// ==========================================
// 2. Main Emitter
// ==========================================

export class WasmBinaryEmitter {
	private ctx = new CompilerContext();

	compile(moduleNode: ModuleNode): Uint8Array {
		this.ctx = new CompilerContext();
		const writer = new BinaryWriter();

		writer.write(
			new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])
		);

		const imports = moduleNode.children.filter(
			(c) => c.type === "import"
		) as any[];
		const functions = moduleNode.children.filter(
			(c) => c.type === "func"
		) as FuncNode[];

		imports.forEach((imp) => {
			const kind = imp.desc && imp.desc.kind;
			if (kind === "memory") this.ctx.importMemCount++;
			else if (kind === "func") this.ctx.importFuncCount++;
			else if (kind === "global") this.ctx.importGlobalCount++;
		});

		functions.forEach((f, i) => {
			if (f.name) {
				this.ctx.funcIndexMap.set(f.name, this.ctx.importFuncCount + i);
			}
			const pTypes = (f.params || []).map((p) => p.valueType!);
			const rTypes = (f.results || []).map((r) => r.valueType!);
			const typeIdx = this.ctx.addType(pTypes, rTypes);
			this.ctx.funcTypeIndices.push(typeIdx);
		});

		this.emitTypeSection(writer);
		this.emitImportSection(writer, imports);
		this.emitFunctionSection(writer);
		this.emitExportSection(writer, moduleNode.children);
		this.emitCodeSection(writer, functions);

		return writer.getData();
	}

	private emitTypeSection(w: BinaryWriter) {
		if (this.ctx.typeSignatures.length === 0) return;
		const section = new BinaryWriter();
		section.u32(this.ctx.typeSignatures.length);
		this.ctx.typeSignatures.forEach((sig) => {
			const [p, r] = sig.split("|");
			const params = p ? p.split(",") : [];
			const results = r ? r.split(",") : [];
			section.u8(0x60);
			section.u32(params.length);
			params.forEach((t) => section.u8(VAL_TYPE[t as keyof typeof VAL_TYPE]));
			section.u32(results.length);
			results.forEach((t) => section.u8(VAL_TYPE[t as keyof typeof VAL_TYPE]));
		});
		this.writeSection(w, SECTION.TYPE, section.getData());
	}

	private emitImportSection(w: BinaryWriter, imports: any[]) {
		if (imports.length === 0) return;
		const section = new BinaryWriter();
		section.u32(imports.length);
		imports.forEach((imp) => {
			section.name(imp.moduleName);
			section.name(imp.fieldName);
			if (imp.desc.kind === "memory") {
				section.u8(KIND.MEMORY);
				const limits = imp.desc.limits;
				const hasMax = limits.max !== undefined;
				const isShared = !!limits.shared;
				let flags = 0;
				if (hasMax) flags |= 0x01;
				if (isShared) flags |= 0x02;
				section.u32(flags);
				section.u32(limits.min);
				if (hasMax) section.u32(limits.max);
			}
		});
		this.writeSection(w, SECTION.IMPORT, section.getData());
	}

	private emitFunctionSection(w: BinaryWriter) {
		if (this.ctx.funcTypeIndices.length === 0) return;
		const section = new BinaryWriter();
		section.u32(this.ctx.funcTypeIndices.length);
		this.ctx.funcTypeIndices.forEach((idx) => section.u32(idx));
		this.writeSection(w, SECTION.FUNC, section.getData());
	}

	private emitExportSection(w: BinaryWriter, nodes: Node[]) {
		const functions = nodes.filter((n) => n.type === "func") as FuncNode[];
		const exports: { name: string; kind: number; index: number }[] = [];
		functions.forEach((f, localIdx) => {
			if (f.name && !f.name.startsWith("$_")) {
				exports.push({
					name: f.name.replace(/^\$/, ""),
					kind: KIND.FUNC,
					index: this.ctx.importFuncCount + localIdx,
				});
			}
		});
		if (exports.length === 0) return;
		const section = new BinaryWriter();
		section.u32(exports.length);
		exports.forEach((e) => {
			section.name(e.name);
			section.u8(e.kind);
			section.u32(e.index);
		});
		this.writeSection(w, SECTION.EXPORT, section.getData());
	}

	private emitCodeSection(w: BinaryWriter, functions: FuncNode[]) {
		if (functions.length === 0) return;
		const section = new BinaryWriter();
		section.u32(functions.length);
		functions.forEach((f) => {
			const funcBody = new BinaryWriter();
			const funcCtx = new FunctionContext(f);
			const locals = f.locals || [];
			const compressed: { count: number; type: number }[] = [];
			if (locals.length > 0) {
				let currentType = locals[0]!.valueType;
				let count = 0;
				for (const l of locals) {
					if (l.valueType === currentType) count++;
					else {
						compressed.push({ count, type: VAL_TYPE[currentType] });
						currentType = l.valueType;
						count = 1;
					}
				}
				compressed.push({ count, type: VAL_TYPE[currentType] });
			}
			funcBody.u32(compressed.length);
			compressed.forEach((c) => {
				funcBody.u32(c.count);
				funcBody.u8(c.type);
			});
			if (f.children) {
				f.children.forEach((node) => this.emitNode(funcBody, node, funcCtx));
			}
			funcBody.u8(0x0b);
			section.u32(funcBody.getData().length);
			section.write(funcBody.getData());
		});
		this.writeSection(w, SECTION.CODE, section.getData());
	}

	// ==========================================
	// 3. Instruction Encoding (Fixed)
	// ==========================================

	private emitNode(w: BinaryWriter, node: Node, fCtx: FunctionContext) {
		// Category 1: Control Flow (Special structure)
		if (["block", "loop", "if"].includes(node.type)) {
			this.emitControlFlow(w, node, fCtx);
			return;
		}

		// Category 2: Constants (Leaf)
		if (node.type === "const") {
			this.emitConst(w, node);
			return;
		}

		// Category 3: Stack Operators (Local/Global/Br/Call/Drop/Return)
		// These typically consume values from stack (except .get)
		if (
			[
				"local.get",
				"local.set",
				"local.tee",
				"global.get",
				"global.set",
				"call",
				"call_indirect",
				"br",
				"br_if",
				"br_table",
				"drop",
				"return",
				"select",
			].includes(node.type)
		) {
			this.emitStackOps(w, node, fCtx);
			return;
		}

		// Category 4: General Operations (Math, Memory, SIMD, Atomics)
		// Rule: Children (Operands) FIRST, then Opcode
		if (node.children) {
			node.children.forEach((c) => this.emitNode(w, c, fCtx));
		}

		let opKey = node.op || node.type;
		const opCode = OPCODES[opKey];

		if (opCode === undefined) {
			throw new Error(`Unknown opcode for node: ${node.type} / ${node.op}`);
		}

		if (opCode > 0xffff) {
			throw new Error("Opcode too large");
		} else if (opCode > 0xff) {
			const prefix = (opCode >> 8) & 0xff;
			const subCode = opCode & 0xff;
			w.u8(prefix);
			w.u32(subCode); // CHANGED: Opcode subcode must be LEB128 encoded (u32), not raw byte (u8)
		} else {
			w.u8(opCode);
		}

		// Immediates
		if (
			opKey.includes(".load") ||
			opKey.includes(".store") ||
			opKey.includes("atomic")
		) {
			const alignLog2 = node.align ? Math.log2(node.align) : 0;
			w.u32(alignLog2);
			w.u32(node.offset || 0);
		} else if (
			opKey.includes("extract_lane") ||
			opKey.includes("replace_lane")
		) {
			w.u8(node.value as number);
		} else if (opKey === "v128.const") {
			const bytes = node.value as number[];
			w.write(new Uint8Array(bytes));
		} else if (opKey === "atomic.fence") {
			w.u8(0x00);
		} else if (opKey.startsWith("memory.")) {
			if (opKey === "memory.init") {
				w.u32(node.value as number);
				w.u8(0x00);
			} else if (opKey === "memory.copy" || opKey === "memory.fill") {
				w.u8(0x00);
				if (opKey === "memory.copy") w.u8(0x00);
			} else {
				w.u8(0x00);
			}
		}
	}

	private emitControlFlow(w: BinaryWriter, node: Node, fCtx: FunctionContext) {
		const opCode = OPCODES[node.type];

		// For 'if', condition is the first child. Emit it BEFORE 'if' opcode.
		if (node.type === "if") {
			if (!node.children || node.children.length === 0)
				throw new Error("If node missing condition");
			this.emitNode(w, node.children[0]!, fCtx);
		}

		w.u8(opCode!);

		const blockType = node.valueType
			? VAL_TYPE[node.valueType as keyof typeof VAL_TYPE]
			: VAL_TYPE.void;
		w.u8(blockType || VAL_TYPE.void);

		fCtx.pushLabel(node.name);

		if (node.type === "if") {
			if (node.consequent) {
				node.consequent.forEach((c) => this.emitNode(w, c, fCtx));
			}
			if (node.alternate && node.alternate.length > 0) {
				w.u8(0x05); // ELSE
				node.alternate.forEach((c) => this.emitNode(w, c, fCtx));
			}
		} else {
			if (node.children) {
				node.children.forEach((c) => this.emitNode(w, c, fCtx));
			}
		}

		w.u8(0x0b); // END
		fCtx.popLabel();
	}

	private emitStackOps(w: BinaryWriter, node: Node, fCtx: FunctionContext) {
		// Emit children (operands) first
		if (node.children) {
			node.children.forEach((c) => this.emitNode(w, c, fCtx));
		}

		w.u8(OPCODES[node.type]!);

		if (node.type === "br" || node.type === "br_if") {
			w.u32(fCtx.getRelativeDepth(node.name || (node.value as string)));
		} else if (node.type === "br_table") {
			// br_table encoding: vec(labelidx) labelidx_default
			const labels = node.value as unknown as string[];
			const defaultLabel = node.name || "";

			// Write number of labels (not including default)
			w.u32(labels.length);

			// Write each label index
			labels.forEach((label) => {
				w.u32(fCtx.getRelativeDepth(label));
			});

			// Write default label index
			w.u32(fCtx.getRelativeDepth(defaultLabel));
		} else if (node.type === "call") {
			const funcName = node.name || "";
			let funcIdx = this.ctx.funcIndexMap.get(funcName);
			if (funcIdx === undefined && /^\d+$/.test(funcName))
				funcIdx = parseInt(funcName);
			w.u32(funcIdx || 0);
		} else if (node.type === "call_indirect") {
			w.u32(node.value as number);
			w.u32(node.offset || 0);
		} else if (node.type.includes("local")) {
			const lName = node.name || "";
			let lIdx = fCtx.localIndexMap.get(lName);
			if (lIdx === undefined && /^\d+$/.test(lName)) lIdx = parseInt(lName);
			w.u32(lIdx || 0);
		} else if (node.type.includes("global")) {
			w.u32(parseInt(node.name?.replace(/\D/g, "") || "0"));
		}
	}

	private emitConst(w: BinaryWriter, node: Node) {
		switch (node.valueType) {
			case "i32":
				w.u8(0x41);
				w.s32(Number(node.value));
				break;
			case "i64":
				w.u8(0x42);
				w.s64(BigInt(node.value as number | string | bigint));
				break;
			case "f32":
				w.u8(0x43);
				w.f32(Number(node.value));
				break;
			case "f64":
				w.u8(0x44);
				w.f64(Number(node.value));
				break;
			default:
				throw new Error(`Unsupported const type: ${node.valueType}`);
		}
	}

	private writeSection(w: BinaryWriter, id: number, payload: Uint8Array) {
		w.u8(id);
		w.u32(payload.length);
		w.write(payload);
	}
}

export function emitBinary(module: ModuleNode): Uint8Array {
	return new WasmBinaryEmitter().compile(module);
}
