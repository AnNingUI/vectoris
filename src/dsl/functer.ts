import { FuncNode, LocalNode, Node, ParamNode, ResultNode } from "./ast";
import { $SType } from "./stypes";

type TupleNode<F, S> = {
	type: "TupleNode";
	f: F;
	s: S;
};

type SingleNode<T> = {
	type: "SingleNode";
	t: T;
};

export function $2<F, S>(f: F, s: S): TupleNode<F, S> {
	return {
		type: "TupleNode",
		f,
		s,
	};
}

type Name = string;
export function $1<T>(t: T): SingleNode<T> {
	return {
		type: "SingleNode",
		t,
	};
}

function $2ToParam<F extends string, S extends $SType>(
	_2: TupleNode<F, S>
): ParamNode {
	return {
		type: "param",
		name: _2.f,
		valueType: _2.s,
	};
}

function $2ToLocals<F extends string, S extends $SType>(
	_2: TupleNode<F, S>
): LocalNode {
	return {
		type: "local",
		name: _2.f,
		valueType: _2.s,
	};
}

function $1ToResult<T extends $SType>(_1: SingleNode<T>): ResultNode {
	return {
		type: "result",
		valueType: _1.t,
	};
}

export function functer(name: string) {
	return {
		params(...params: (ParamNode | TupleNode<Name, $SType>)[]) {
			return {
				results(...results: (ResultNode | SingleNode<$SType>)[]) {
					return {
						locals(...locals: (LocalNode | TupleNode<Name, $SType>)[]) {
							return {
								body(
									fn: (push: (...nodes: Node[]) => number) => void
								): FuncNode {
									const body: Node[] = [];
									fn(body.push.bind(body));
									return {
										type: "func",
										name,
										params: params.map((node) =>
											node.type === "TupleNode" ? $2ToParam(node) : node
										),
										results: results.map((node) =>
											node.type === "SingleNode" ? $1ToResult(node) : node
										),
										locals: locals.map((node) =>
											node.type === "TupleNode" ? $2ToLocals(node) : node
										),
										children: body,
									};
								},
							};
						},
					};
				},
			};
		},
	};
}
