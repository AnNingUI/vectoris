import { defineConfig } from "tsdown";

export default defineConfig([
	// ESM build
	{
		entry: ["./src/index.ts"],
		format: "esm",
		outDir: "dist",
		dts: true,
		clean: true,
		sourcemap: true,
		minify: false,
		treeshake: true,
		platform: "neutral",
		target: "es2020",
	},
	// CJS build
	{
		entry: ["./src/index.ts"],
		format: "cjs",
		outDir: "dist",
		dts: true,
		clean: false, // Don't clean again after ESM build
		sourcemap: true,
		minify: false,
		treeshake: true,
		platform: "neutral",
		target: "es2020",
	},
	// UMD build
	{
		entry: ["./src/index.ts"],
		format: "umd",
		outDir: "dist",
		dts: false,
		clean: false, // Don't clean again after ESM build
		sourcemap: true,
		minify: false,
		treeshake: true,
		platform: "neutral",
		target: "es2020",
		// name: "Vectoris$",
		outputOptions: {
			name: "Vectoris$",
		},
	},
	// IIFE
	// {

	// }
]);
