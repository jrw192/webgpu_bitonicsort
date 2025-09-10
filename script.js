async function main(gridSize) {
    // ------------ setup ------------
    const canvas = document.querySelector("canvas");
    if (!navigator.gpu) {
        alert("WebGPU not supported on this browser.");
        throw new Error("WebGPU not supported on this browser.");
    }

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

    // ------------ define uniformBuffer for grid ------------

    // const GRID_SIZE = 128;
    const GRID_SIZE = gridSize;
    const uniformArray = new Float32Array([GRID_SIZE, GRID_SIZE]);
    const uniformBuffer = device.createBuffer({
        label: "uniform",
        size: uniformArray.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(uniformBuffer, 0, uniformArray);

    // ------------ define uniformBuffer for stage ------------
    const stageBuffer = device.createBuffer({
        label: "stage info",
        size: 3 * 4 + 4, // 3 u32s + 4 bytes padding
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

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
    for (let i = 0; i < stateArray.length; i++) {
        stateArray[i] = Math.round(Math.random() * 10) / 10;
    }
    device.queue.writeBuffer(stateBuffers[1], 0, stateArray);


    // ------------ compute shader module ------------
    const WORKGROUP_SIZE = gridSize / 4;
    const computeShaderModule = device.createShaderModule({
        label: "compute shader module",
        code: /*wgsl*/`
            struct ComputeInput {
                @builtin(global_invocation_id) invocation_id: vec3u,
            }

            struct StageData {
                grid_size: u32,
                stage_id: u32,
                pass_id: u32,
            };

            @group(0) @binding(0) var<uniform> grid: vec2f;
            // bind the 2 cell state arrays
            @group(0) @binding(1) var<storage> cellStateIn: array<f32>;
            @group(0) @binding(2) var<storage, read_write> cellStateOut: array<f32>;
            @group(0) @binding(3) var<uniform> stage: StageData;

            @compute @workgroup_size(${WORKGROUP_SIZE}, 1, 1)
            fn computeMain(input: ComputeInput) {
                // step 1: identify your unique position (id)
                let index = input.invocation_id.x;

                // step 2: determine partner's position
                let partnerIndex = index ^ stage.pass_id;

                // step 3: avoid duplication
                if (index > partnerIndex) {
                    return;
                }

                // step 4: determine sorting direction (ascending/descending)
                let stageId = stage.stage_id;
                var ascending = false;
                if ((index & stageId) == 0) {
                    ascending = true;
                }   

                // step 5: fetch the numbers
                let num1 = cellStateIn[index];
                let num2 = cellStateIn[partnerIndex];

                // step 6: compare and swap
                if (ascending) {
                    cellStateOut[index] = min(num2, num1);
                    cellStateOut[partnerIndex] = max(num2, num1);
                } else {
                    cellStateOut[index] = max(num1, num2);
                    cellStateOut[partnerIndex] = min(num1, num2);
                }
            } 
        `
    });


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
                return vec4f(.5,.5,.5,state[i]+.05); // (Red, Green, Blue, Alpha)
            }
        `
    });

    // ------------ set up bind groups ------------
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
        },
        {
            binding: 3,
            visibility: GPUShaderStage.COMPUTE,
            buffer: {}
        },
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
            }, {
                binding: 2,
                resource: { buffer: stateBuffers[1] }
            }, {
                binding: 3,
                resource: { buffer: stageBuffer }
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
            }, {
                binding: 3,
                resource: { buffer: stageBuffer }
            }
            ],
        })
    ];

    // ------------ render + compute pipelines ------------
    const computePipeline = device.createComputePipeline({
        label: "compute pipeline",
        layout: pipelineLayout,
        compute: {
            module: computeShaderModule,
            entryPoint: "computeMain",
        }
    });


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

    async function render() {
        const N = GRID_SIZE * GRID_SIZE;
        let step = 0;

        for (let stage = 2; stage <= N; stage *= 2) {
            for (let pass = stage / 2; pass > 0; pass /= 2) {
                function doStep() {
                    // console.log('pass', pass);
                    const encoder = device.createCommandEncoder();
                    device.queue.writeBuffer(stageBuffer, 0, new Uint32Array([GRID_SIZE, stage, pass]));
                    // compute pass
                    const computePass = encoder.beginComputePass();
                    computePass.setPipeline(computePipeline);
                    computePass.setBindGroup(0, bindGroups[step % 2]);
                    const workgroupCount = Math.ceil(N / WORKGROUP_SIZE);

                    computePass.dispatchWorkgroups(workgroupCount, workgroupCount);
                    computePass.end();


                    // draw pass
                    const drawPass = encoder.beginRenderPass({
                        colorAttachments: [{
                            view: context.getCurrentTexture().createView(),
                            loadOp: "clear",
                            clearValue: { r: 0, g: 0, b: 0.3, a: 1 },
                            storeOp: "store",
                        }]
                    });
                    // Bind the bind group 
                    drawPass.setBindGroup(0, bindGroups[step % 2]);

                    drawPass.setPipeline(renderPipeline);
                    drawPass.setVertexBuffer(0, vertexBuffer);

                    drawPass.draw(vertices.length / 2, N);
                    drawPass.end();

                    device.queue.submit([encoder.finish()]);

                    step += 1;
                }
                setTimeout(doStep, 10);
            }
        }
    }

    render();

}