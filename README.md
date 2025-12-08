# Vectoris

**(Easy WASM Use in TS) Parallel Computing Framework**

Vectoris is a high-performance parallel computing framework that allows you to write WebAssembly kernels using a TypeScript DSL, with built-in support for multi-threading and SIMD operations.

## Features

- **AST-based DSL**: Write WebAssembly kernels using TypeScript functions that generate ASTs
- **Multi-threading**: Built-in worker pool with SharedArrayBuffer for parallel execution
- **Single-threaded scheduler**: Time-sliced execution to prevent blocking the main thread
- **SIMD support**: Generate vectorized WebAssembly code for parallel operations
- **Caching**: Automatic WebAssembly module compilation caching
- **Memory management**: Built-in shared memory support for multi-threaded operations

## Installation

```bash
npm install vectoris
```

## Usage

### Basic Example: Creating and Executing a WASM Kernel

```typescript
import { Ast as d } from "vectoris"; // DSL stands for AST
import { compileWasm } from "vectoris";
import { WorkerPool } from "vectoris";

// Define a simple kernel that adds a value to each element in an array
const kernel = d.module("map_kernel", [
  d.importMemory("env", "memory", { min: 1, max: 16, shared: true }),

  d.func(
    "main",
    [d.param("start", "i32"), d.param("end", "i32"), d.param("delta", "i32")],
    [],
    [d.local("i", "i32"), d.local("ptr", "i32")],
    [
      d.localSet("i", d.localGet("start")),
      d.block("B", [
        d.loop("L", [
          d.brIf("B", d.i32GeU(d.localGet("i"), d.localGet("end"))),
          d.localSet("ptr", d.i32Shl(d.localGet("i"), d.i32Const(2))),
          d.i32Store(
            d.localGet("ptr"),
            d.i32Add(d.i32Load(d.localGet("ptr")), d.localGet("delta"))
          ),
          d.localSet("i", d.i32Add(d.localGet("i"), d.i32Const(1))),
          d.br("L"),
        ]),
      ]),
    ]
  ),

  d.exportFunc("main"),
]);

// Compile the kernel to WebAssembly
const wasmModule = await compileWasm(kernel);

// Create shared memory for the kernel
import { createMemoryForSize, createInt32View } from "vectoris";

const COUNT = 1000;
const memory = createMemoryForSize(COUNT * 4);
const view = createInt32View(memory);

// Initialize data
for (let i = 0; i < COUNT; i++) view[i] = i;

const pool = new WorkerPool({ concurrency: 4 });
await pool.init();

// Execute: arr[i] = arr[i] + 10
await pool.exec(wasmModule, COUNT, memory, [10]);

// Results are now available in the shared memory
console.log(view[0]);    // 10
console.log(view[500]);  // 510
console.log(view[999]);  // 1009

// Clean up
pool.terminate();
```

### SIMD Operations

Vectoris supports SIMD operations through the DSL:

```typescript
import { Ast as d } from "vectoris";

// SIMD vector addition: add 4 integers at once
const simdKernel = d.module("simd_add", [
  d.importMemory("env", "memory", { min: 1 }),

  d.func(
    "vec_add",
    [d.param("a_off", "i32"), d.param("b_off", "i32"), d.param("out_off", "i32")],
    [],
    [d.local("v_a", "v128"), d.local("v_b", "v128"), d.local("v_r", "v128")],
    [
      // Load two 4-element vectors
      d.localSet("v_a", d.v128Load(d.localGet("a_off"))),
      d.localSet("v_b", d.v128Load(d.localGet("b_off"))),

      // Add them element-wise
      d.localSet("v_r", d.i32x4Add(d.localGet("v_a"), d.localGet("v_b"))),

      // Store result
      d.v128Store(d.localGet("out_off"), d.localGet("v_r")),
    ]
  ),

  d.exportFunc("vec_add"),
]);
```

### Single-threaded Scheduling

For main thread execution without blocking, use the single-threaded executor:

```typescript
import { MainThreadExecutor } from "vectoris";

const executor = new MainThreadExecutor({
  baseSliceTime: 5,      // 5ms time slices for responsiveness
  maxContinuousTime: 50, // Allow up to 50ms of continuous execution
  debug: false
});

// Execute without blocking the main thread
await executor.run(
  kernel,           // AST or compiled WebAssembly module
  totalSize,        // Total size of work
  memory,           // WebAssembly memory
  [param1, param2], // Additional parameters
  { entryPoint: "main" } // Options
);
```

### Memory Layout with Macro System

Vectoris includes a macro system for working with structured memory:

```typescript
import { Struct, Enum, match } from "vectoris";

// Define memory layouts
const Point = Struct({
  x: "i32",  // offset 0, size 4
  y: "i32"   // offset 4, size 4
});

// Use in WASM kernels
const kernel = d.module("struct_test", [
  d.importMemory("env", "memory", { min: 1 }),
  d.func(
    "read_y",
    [d.param("ptr", "i32")],
    [d.result("i32")],
    [],
    [
      // Access Point.y field
      Point.at(d.localGet("ptr")).y.load(),
    ]
  ),
  d.exportFunc("read_y"),
]);
```

## Architecture

### AST Compilation Pipeline

1. **DSL**: Write WebAssembly operations using TypeScript functions (`d.i32Add`, `d.localGet`, etc.)
2. **AST Generation**: Functions create Abstract Syntax Tree nodes representing WebAssembly instructions
3. **Binary Emission**: AST is compiled to WebAssembly binary format using `emitBinary`
4. **Compilation**: Binary is compiled to WebAssembly module using `WebAssembly.compile`
5. **Caching**: Compiled modules are cached for reuse

### Multi-threading with Work Stealing

The `WorkerPool` uses an atomic work-stealing algorithm:

1. **Workers**: Multiple Web Workers are initialized with the same WebAssembly module
2. **Shared Memory**: All workers share the same WebAssembly.Memory instance
3. **Atomic Cursor**: Workers use Atomics.add to coordinate work distribution
4. **Work Stealing**: Each worker claims chunks of work by atomically incrementing a cursor
5. **Load Balancing**: Workers continue until all work is completed

### Main Thread Scheduling

The `MainThreadExecutor` prevents blocking:

1. **Time Slicing**: Execution is split into small chunks (default 5ms)
2. **Input Detection**: Uses `navigator.scheduling.isInputPending()` to detect user input
3. **Dynamic Adjustment**: Increases time slices when safe to do so
4. **Yielding**: Uses MessageChannel to yield to main thread between slices
5. **Adaptive Chunking**: Adjusts chunk size based on execution speed

## Supported Operations

Vectoris supports most WebAssembly 1.0 and SIMD operations:

- **Basic Operations**: Arithmetic, bitwise, comparisons
- **Memory Operations**: Load, store, atomic operations
- **Control Flow**: Blocks, loops, if/then/else, branches
- **SIMD**: Vector operations for i8x16, i16x8, i32x4, f32x4, f64x2
- **Atomics**: Thread-safe atomic operations and memory operations

## Browser Support

- WebAssembly support (Chrome 57+, Firefox 52+, Safari 11+)
- For multi-threading: SharedArrayBuffer and Atomics support
- For main thread scheduling: `navigator.scheduling.isInputPending()` (Chrome 87+)

## License

MIT