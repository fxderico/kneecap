#![cfg(target_arch = "wasm32")]

use std::cell::RefCell;

use compositor::{Compositor, FrameDescriptor, RenderFrameOptions};
use gpu::wgpu;
use js_sys::Object;
use wasm_bindgen::{JsCast, JsValue, prelude::wasm_bindgen};

use crate::gpu::{
    import_canvas_texture, read_offscreen_canvas_property, read_serde_property, read_u32_property,
    with_gpu_runtime,
};
use crate::perf;

struct CompositorRuntime {
    canvas: web_sys::HtmlCanvasElement,
    compositor: Compositor,
    /// `Some` on WebGPU, where a fresh surface per canvas is fine. `None` on
    /// the WebGL fallback: that canvas already owns the one surface it is
    /// ever allowed (`GpuContext::gl_surface`), so frames are presented
    /// through `render_texture_to_gl_canvas_surface` instead. Creating a
    /// second surface on a WebGL canvas panics (wgpu #2343 / #7480), which
    /// is what took the whole editor down on iOS.
    surface: Option<wgpu::Surface<'static>>,
    surface_size: (u32, u32),
}

thread_local! {
    static COMPOSITOR_RUNTIME: RefCell<Option<CompositorRuntime>> = const { RefCell::new(None) };
}

#[wasm_bindgen(js_name = initCompositor)]
pub fn init_compositor(width: u32, height: u32) -> Result<(), JsValue> {
    with_gpu_runtime(|gpu_runtime| {
        // On WebGL, wgpu is bound to a specific canvas; reuse it so the UI
        // can mount the output directly instead of copying pixels through
        // an intermediate 2D canvas every frame. On WebGPU, surface rendering
        // works against any canvas so we create a fresh one.
        let (canvas, surface) = if let Some(gl_canvas) = gpu_runtime.context.gl_canvas() {
            // WebGL: no new surface here — GpuContext already holds the one
            // surface this canvas is allowed, and render_frame presents
            // through it via render_texture_to_gl_canvas_surface.
            (gl_canvas.clone(), None)
        } else {
            let document = web_sys::window()
                .and_then(|window| window.document())
                .ok_or_else(|| JsValue::from_str("Document is not available"))?;
            let canvas = document
                .create_element("canvas")?
                .dyn_into::<web_sys::HtmlCanvasElement>()
                .map_err(|_| JsValue::from_str("Failed to create compositor canvas"))?;
            canvas.set_width(width);
            canvas.set_height(height);
            let surface = gpu_runtime
                .context
                .instance()
                .create_surface(wgpu::SurfaceTarget::Canvas(canvas.clone()))
                .map_err(|error| JsValue::from_str(&error.to_string()))?;
            gpu_runtime
                .context
                .configure_surface(&surface, width, height)
                .map_err(|error| JsValue::from_str(&error.to_string()))?;
            (canvas, Some(surface))
        };
        canvas.set_width(width);
        canvas.set_height(height);

        let compositor = Compositor::new(&gpu_runtime.context);

        COMPOSITOR_RUNTIME.with(|runtime| {
            runtime.replace(Some(CompositorRuntime {
                canvas,
                compositor,
                surface,
                surface_size: (width, height),
            }));
        });

        Ok(())
    })
}

#[wasm_bindgen(js_name = resizeCompositor)]
pub fn resize_compositor(width: u32, height: u32) -> Result<(), JsValue> {
    with_gpu_runtime(|gpu_runtime| {
        COMPOSITOR_RUNTIME.with(|runtime| {
            let mut borrow = runtime.borrow_mut();
            let Some(runtime) = borrow.as_mut() else {
                return Err(JsValue::from_str(
                    "Compositor is not initialized. Call initCompositor() first.",
                ));
            };
            runtime.canvas.set_width(width);
            runtime.canvas.set_height(height);
            if runtime.surface_size != (width, height) {
                if let Some(surface) = runtime.surface.as_ref() {
                    gpu_runtime
                        .context
                        .configure_surface(surface, width, height)
                        .map_err(|error| JsValue::from_str(&error.to_string()))?;
                }
                // WebGL: the gl_canvas surface is reconfigured lazily inside
                // render_texture_to_gl_canvas_surface on the next frame.
                runtime.surface_size = (width, height);
            }
            Ok(())
        })
    })
}

#[wasm_bindgen(js_name = getCompositorCanvas)]
pub fn get_compositor_canvas() -> Result<web_sys::HtmlCanvasElement, JsValue> {
    COMPOSITOR_RUNTIME.with(|runtime| {
        let borrow = runtime.borrow();
        let Some(runtime) = borrow.as_ref() else {
            return Err(JsValue::from_str(
                "Compositor is not initialized. Call initCompositor() first.",
            ));
        };
        Ok(runtime.canvas.clone())
    })
}

#[wasm_bindgen(js_name = uploadTexture)]
pub fn upload_texture(options: JsValue) -> Result<(), JsValue> {
    let UploadTextureOptions {
        id,
        source,
        width,
        height,
    } = parse_upload_texture_options(options)?;

    with_gpu_runtime(|gpu_runtime| {
        COMPOSITOR_RUNTIME.with(|runtime| {
            let mut borrow = runtime.borrow_mut();
            let Some(runtime) = borrow.as_mut() else {
                return Err(JsValue::from_str(
                    "Compositor is not initialized. Call initCompositor() first.",
                ));
            };

            let texture = import_canvas_texture(
                &gpu_runtime.context,
                &source,
                width,
                height,
                "compositor-upload-texture",
            );
            runtime.compositor.upsert_texture(id, texture);
            Ok(())
        })
    })
}

#[wasm_bindgen(js_name = releaseTexture)]
pub fn release_texture(id: String) -> Result<(), JsValue> {
    COMPOSITOR_RUNTIME.with(|runtime| {
        let mut borrow = runtime.borrow_mut();
        let Some(runtime) = borrow.as_mut() else {
            return Err(JsValue::from_str(
                "Compositor is not initialized. Call initCompositor() first.",
            ));
        };
        runtime.compositor.release_texture(&id);
        Ok(())
    })
}

#[wasm_bindgen(js_name = renderFrame)]
pub fn render_frame(options: JsValue) -> Result<(), JsValue> {
    perf::reset();

    let t_deserialize = perf::now_ms();
    let frame: FrameDescriptor = serde_wasm_bindgen::from_value(options)
        .map_err(|error| JsValue::from_str(&format!("Invalid frame descriptor: {error}")))?;
    perf::record("wasm.deserialize", perf::now_ms() - t_deserialize);

    with_gpu_runtime(|gpu_runtime| {
        COMPOSITOR_RUNTIME.with(|runtime| {
            let mut borrow = runtime.borrow_mut();
            let Some(runtime) = borrow.as_mut() else {
                return Err(JsValue::from_str(
                    "Compositor is not initialized. Call initCompositor() first.",
                ));
            };

            if runtime.surface_size != (frame.width, frame.height) {
                runtime.canvas.set_width(frame.width);
                runtime.canvas.set_height(frame.height);
                if let Some(surface) = runtime.surface.as_ref() {
                    let t_surface = perf::now_ms();
                    gpu_runtime
                        .context
                        .configure_surface(surface, frame.width, frame.height)
                        .map_err(|error| JsValue::from_str(&error.to_string()))?;
                    perf::record("wasm.surfaceConfigure", perf::now_ms() - t_surface);
                }
                runtime.surface_size = (frame.width, frame.height);
            }

            if let Some(surface) = runtime.surface.as_ref() {
                // WebGPU: composite straight to the canvas surface.
                let t_render = perf::now_ms();
                let result = runtime
                    .compositor
                    .render_frame(
                        &gpu_runtime.context,
                        RenderFrameOptions {
                            frame: &frame,
                            surface,
                        },
                    )
                    .map_err(|error| JsValue::from_str(&error.to_string()));
                perf::record("wasm.renderFrameToSurface", perf::now_ms() - t_render);
                result
            } else {
                // WebGL: composite to a texture, then present it through the
                // GpuContext's single cached gl_canvas surface — the only
                // surface that canvas is allowed.
                let t_composite = perf::now_ms();
                let texture = runtime
                    .compositor
                    .render_frame_to_texture(&gpu_runtime.context, &frame)
                    .map_err(|error| JsValue::from_str(&error.to_string()))?;
                perf::record("wasm.compositeToTexture", perf::now_ms() - t_composite);

                let t_present = perf::now_ms();
                gpu_runtime
                    .context
                    .render_texture_to_gl_canvas_surface(&texture, frame.width, frame.height)
                    .map_err(|error| JsValue::from_str(&error.to_string()))?;
                perf::record("wasm.presentToSurface", perf::now_ms() - t_present);

                Ok(())
            }
        })
    })
}

#[derive(Debug)]
struct UploadTextureOptions {
    id: String,
    source: wgpu::web_sys::OffscreenCanvas,
    width: u32,
    height: u32,
}

fn parse_upload_texture_options(value: JsValue) -> Result<UploadTextureOptions, JsValue> {
    let object: Object = value
        .dyn_into()
        .map_err(|_| JsValue::from_str("uploadTexture expects an options object"))?;

    Ok(UploadTextureOptions {
        id: read_serde_property(&object, "id")?,
        source: read_offscreen_canvas_property(&object, "source")?,
        width: read_u32_property(&object, "width")?,
        height: read_u32_property(&object, "height")?,
    })
}
