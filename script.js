async function main() {
    // ------------ setup ------------
    const canvas = document.querySelector("canvas");
    if (!navigator.gpu) {
        throw new Error("WebGPU not supported on this browser.");
    }
    console.log(navigator.gpu);

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
        throw new Error("No appropriate GPUAdapter found.");
    }
    const device = await adapter.requestDevice();

    const context = canvas.getContext("webgpu");
    const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
    context.configure({
        device: device,
        format: canvasFormat,
    });


    // ------------ define vertexBuffer ------------
    const vertices = new Float32Array([
        //   X,    Y,
        -0.9, -0.9,
        0.9, -0.9,
        0.9, 0.9,

        -0.9, -0.9,
        0.9, 0.9,
        -0.9, 0.9,
    ]);

    const vertexBuffer = device.createBuffer({
        label: "vertices",
        size: vertices.byteLength, // size in bytes 
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST, // specify what will go in it, and what you want to do to it
    });

    // copy the vertexes into the buffer's memory
    device.queue.writeBuffer(vertexBuffer, 0, vertices);

    // tell webgpu more about the structure of the vertex data
    const vertexBufferLayout = {
        arrayStride: 8, // vertex byte length
        attributes: [{
            format: "float32x2", // data type of the vertex
            offset: 0,
            shaderLocation: 0,
        }],
    };

    // ------------ define uniformBuffer ------------
    const GRID_SIZE = 16;
    const uniformArray = new Float32Array([GRID_SIZE, GRID_SIZE]);
    const uniformBuffer = device.createBuffer({
        label: "uniform",
        size: uniformArray.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(uniformBuffer, 0, uniformArray);


    // ------------ define stateBuffer ------------
    const stateArray = new Float32Array(GRID_SIZE * GRID_SIZE);
    // pingpong state
    const stateBuffers = [
        device.createBuffer({
            label: "state A",
            size: stateArray.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        }),
        device.createBuffer({
            label: "state B",
            size: stateArray.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        })
    ];
    for (let i = 0; i < stateArray.length; i++) {
        stateArray[i] = Math.round(Math.random() * 10) / 10;
    }
    device.queue.writeBuffer(stateBuffers[0], 0, stateArray);
    console.log(stateArray);
    for (let i = 0; i < stateArray.length; i++) {
        stateArray[i] = Math.round(Math.random() * 10) / 10;
    }
    device.queue.writeBuffer(stateBuffers[1], 0, stateArray);


    // debug


    // ------------ vertex + frag shader module ------------
    const shaderModule = device.createShaderModule({
        label: "shader module",
        code: /*wgsl*/`
          struct VertexInput {
            @location(0) pos: vec2f,
            @builtin(instance_index) instance: u32,
          }
          struct VertexOutput {
            @builtin(position) pos: vec4f,
            @location(0) cell: vec2f,
            @location(1) instance: f32,
          }
          struct FragmentInput {
            @location(1) instance: f32,
          }

            @group(0) @binding(0) var<uniform> grid: vec2f;
            @group(0) @binding(1) var<storage> state: array<f32>;

            @vertex
            fn vertexMain(input: VertexInput) -> VertexOutput {
                let i = f32(input.instance); // cast instance from u32 to f32 for the vec2f
                let state = f32(state[input.instance]);
                let cell = vec2f(i % grid.x, floor(i / grid.x)); // calculate the cell coordinates using the instance
                let cellOffset = cell / grid * 2;
                // translate the square into a grid space, translate the coordinate system into bottom left corner
                // and then move it by the cell offset
                let gridPos = ((input.pos+1) / grid) -1 + cellOffset;
                var output: VertexOutput;
                output.pos = vec4f(gridPos, 0, 1);
                output.cell = cell;
                output.instance = i;
                return output;
            }
            
            @fragment
            fn fragmentMain(input: FragmentInput) -> @location(0) vec4f {
                let i = u32(input.instance);
                return vec4f(.5,.5,.5,state[i]); // (Red, Green, Blue, Alpha)
            }
        `
    });

    // ------------ render pipeline ------------
    // create the bind group layout and pipeline layout.
    const bindGroupLayout = device.createBindGroupLayout({
        label: "bind group layout",
        entries: [{
            binding: 0,
            visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
            buffer: {} // grid uniform buffer
        }, {
            binding: 1,
            visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
            buffer: { type: "read-only-storage" } // state input buffer
        },
        {
            binding: 2,
            visibility: GPUShaderStage.COMPUTE,
            buffer: { type: "storage" } // state output buffer
        }
        ]
    });
    const pipelineLayout = device.createPipelineLayout({
        label: "pipeline layout",
        bindGroupLayouts: [bindGroupLayout],
    });

    const bindGroups = [
        device.createBindGroup({
            label: "bind group A",
            layout: bindGroupLayout,
            entries: [{
                binding: 0,
                resource: { buffer: uniformBuffer }
            }, {
                binding: 1,
                resource: { buffer: stateBuffers[0] }
            },
            {
                binding: 2,
                resource: { buffer: stateBuffers[1] }
            }
            ],
        }),
        device.createBindGroup({
            label: "bind group B",
            layout: bindGroupLayout,
            entries: [{
                binding: 0,
                resource: { buffer: uniformBuffer }
            }, {
                binding: 1,
                resource: { buffer: stateBuffers[1] }
            },
            {
                binding: 2,
                resource: { buffer: stateBuffers[0] }
            }
            ],
        })
    ];

    const renderPipeline = device.createRenderPipeline({
        label: "render pipeline",
        layout: pipelineLayout,
        vertex: {
            module: shaderModule,
            entryPoint: "vertexMain",
            buffers: [vertexBufferLayout]
        },
        fragment: {
            module: shaderModule,
            entryPoint: "fragmentMain",
            targets: [{
                format: canvasFormat,
                blend: {
                    color: {
                        srcFactor: 'src-alpha',
                        dstFactor: 'one-minus-src-alpha',
                        operation: 'add',
                    },
                    alpha: {
                        srcFactor: 'one',
                        dstFactor: 'zero',
                        operation: 'add',
                    },
                },
            }]
        }
    });


    let step = 0;
    function render() {
        // console.log('step',step);
        step += 1;
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view: context.getCurrentTexture().createView(),
                loadOp: "clear",
                clearValue: { r: 0, g: 0, b: 1, a: 1 },
                storeOp: "store",
            }]
        });

        pass.setPipeline(renderPipeline);
        pass.setVertexBuffer(0, vertexBuffer);
        pass.setBindGroup(0, bindGroups[step % 2]);

        pass.draw(vertices.length / 2, GRID_SIZE * GRID_SIZE);
        pass.end();

        device.queue.submit([encoder.finish()]);
    }

    setInterval(render, 1000);

}

main();