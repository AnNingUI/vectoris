/**
 * @description 所有 wasm 和 js 可交互类型
 */
export const $S = Object.freeze({
	i32: "i32",
	i64: "i64",
	f32: "f32",
	f64: "f64",
	v128: "v128",
});

export type $SType = keyof typeof $S;
