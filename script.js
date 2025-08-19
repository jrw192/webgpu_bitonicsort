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
        -1.0, -1.0,
        1.0, -1.0,
        1.0, 1.0,

        -1.0, -1.0,
        1.0, 1.0,
        -1.0, 1.0,
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
    const uniformArray = new Float32Array(GRID_SIZE * GRID_SIZE);
    const uniformBuffer = device.createBuffer({
        label: "vertices",
        size: vertices.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(uniformBuffer, 0, uniformArray);


    // ------------ define stateBuffer ------------


    // ------------ vertex + frag shader module ------------
    const shaderModule = device.createShaderModule({
        label: "shader module",
        code: /*wgsl*/`
            @vertex
            fn vertexMain(@location(0) pos: vec2f) -> @builtin(position) vec4f {
                return vec4f(pos,0,1);
            }
            
            @fragment
            fn fragmentMain() -> @location(0) vec4f {
            return vec4f(1, 0, 0, 1); // (Red, Green, Blue, Alpha)
            }
        `
    });

    // ------------ render pipeline ------------
    const renderPipeline = device.createRenderPipeline({
        label: "render pipeline",
        layout: "auto",
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
            }]
        }
    });

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
    // pass.draw(vertices.length / 2);
    pass.end();

    device.queue.submit([encoder.finish()]);


}

main();