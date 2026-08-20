struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) tex_coord: vec2f,
}

struct EffectUniforms {
    resolution: vec2f,
    direction: vec2f,
    // x = brightness add (-0.35..0.35), y = contrast mult, z = saturation mult, w = sharpen amount (0..1)
    scalars: vec4f,
    // x = temperature (-1..1), y = tint (-1..1), z = vignette (0..1), w = unused
    scalars2: vec4f,
}

@group(0) @binding(0) var input_texture: texture_2d<f32>;
@group(0) @binding(1) var input_sampler: sampler;
@group(1) @binding(0) var<uniform> uniforms: EffectUniforms;

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    var color = textureSample(input_texture, input_sampler, input.tex_coord);

    // Unsharp-mask sharpen against the 4-neighbor average (1px radius).
    let sharpen = uniforms.scalars.w;
    if (sharpen > 0.0) {
        let texel = vec2f(1.0, 1.0) / uniforms.resolution;
        let n = textureSample(input_texture, input_sampler, input.tex_coord + vec2f(0.0, -texel.y)).rgb
            + textureSample(input_texture, input_sampler, input.tex_coord + vec2f(0.0, texel.y)).rgb
            + textureSample(input_texture, input_sampler, input.tex_coord + vec2f(-texel.x, 0.0)).rgb
            + textureSample(input_texture, input_sampler, input.tex_coord + vec2f(texel.x, 0.0)).rgb;
        color = vec4f(color.rgb + (color.rgb - n / 4.0) * sharpen * 1.5, color.a);
    }

    // Temperature (warm/cool) and tint (magenta/green).
    let temperature = uniforms.scalars2.x;
    let tint = uniforms.scalars2.y;
    color.r = color.r + temperature * 0.12 + tint * 0.05;
    color.b = color.b - temperature * 0.12 + tint * 0.05;
    color.g = color.g - tint * 0.10;

    // Brightness (add), contrast (around mid-gray), saturation (luma mix).
    color = vec4f(color.rgb + vec3f(uniforms.scalars.x), color.a);
    color = vec4f((color.rgb - vec3f(0.5)) * uniforms.scalars.y + vec3f(0.5), color.a);
    let luma = dot(color.rgb, vec3f(0.2126, 0.7152, 0.0722));
    color = vec4f(mix(vec3f(luma), color.rgb, uniforms.scalars.z), color.a);

    // Vignette: darken toward corners.
    let vignette = uniforms.scalars2.z;
    if (vignette > 0.0) {
        let centered = input.tex_coord - vec2f(0.5, 0.5);
        let falloff = smoothstep(0.35, 0.9, length(centered) * 1.6);
        color = vec4f(color.rgb * (1.0 - falloff * vignette), color.a);
    }

    return vec4f(clamp(color.rgb, vec3f(0.0), vec3f(1.0)), color.a);
}
