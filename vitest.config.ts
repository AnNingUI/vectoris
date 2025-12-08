// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// 增加超时时间
		testTimeout: 30000, // 30秒
		hookTimeout: 10000, // 10秒

		// 包含所有测试
		include: ["**/*.test.ts"],

		// 环境变量
		env: {
			NODE_ENV: "test",
		},

		// 报告器
		reporters: ["verbose"],

		// 覆盖率设置
		coverage: {
			enabled: false, // 性能测试时关闭覆盖率
		},
	},
});
