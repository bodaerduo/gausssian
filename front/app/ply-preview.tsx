'use client';

import { useEffect, useRef, useState } from 'react';

type PlyProperty = { name: string; type: string; offset: number; size: number };
type PointCloud = {
  positions: Float32Array;
  colors: Float32Array;
  scales: Float32Array;
  opacities: Float32Array;
  center: [number, number, number];
  radius: number;
};

const TYPE_SIZES: Record<string, number> = {
  char: 1, int8: 1, uchar: 1, uint8: 1,
  short: 2, int16: 2, ushort: 2, uint16: 2,
  int: 4, int32: 4, uint: 4, uint32: 4,
  float: 4, float32: 4, double: 8, float64: 8,
};
const SH_C0 = 0.28209479177387814;

function sigmoid(value: number) { return 1 / (1 + Math.exp(-value)); }
function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, value)); }

function readBinaryValue(view: DataView, offset: number, type: string, littleEndian: boolean) {
  switch (type) {
    case 'char': case 'int8': return view.getInt8(offset);
    case 'uchar': case 'uint8': return view.getUint8(offset);
    case 'short': case 'int16': return view.getInt16(offset, littleEndian);
    case 'ushort': case 'uint16': return view.getUint16(offset, littleEndian);
    case 'int': case 'int32': return view.getInt32(offset, littleEndian);
    case 'uint': case 'uint32': return view.getUint32(offset, littleEndian);
    case 'double': case 'float64': return view.getFloat64(offset, littleEndian);
    default: return view.getFloat32(offset, littleEndian);
  }
}

function parsePly(buffer: ArrayBuffer, maxPoints: number): PointCloud {
  const bytes = new Uint8Array(buffer);
  const headerPreview = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 1024 * 1024)));
  const headerEnd = headerPreview.indexOf('end_header');
  if (headerEnd < 0) throw new Error('PLY 缺少 end_header');
  const dataLineEnd = headerPreview.indexOf('\n', headerEnd);
  if (dataLineEnd < 0) throw new Error('PLY 文件头不完整');
  const header = headerPreview.slice(0, dataLineEnd).split(/\r?\n/);
  const formatLine = header.find((line) => line.startsWith('format '));
  const format = formatLine?.split(/\s+/)[1];
  const littleEndian = format !== 'binary_big_endian';
  const vertexLineIndex = header.findIndex((line) => line.startsWith('element vertex '));
  if (vertexLineIndex < 0) throw new Error('PLY 缺少 vertex 元素');
  const vertexCount = Number(header[vertexLineIndex].split(/\s+/)[2]);
  if (!Number.isFinite(vertexCount) || vertexCount <= 0) throw new Error('PLY 没有有效顶点');

  const properties: PlyProperty[] = [];
  let offset = 0;
  for (const line of header.slice(vertexLineIndex + 1)) {
    if (line.startsWith('element ')) break;
    const parts = line.split(/\s+/);
    if (parts[0] !== 'property' || parts[1] === 'list') continue;
    const size = TYPE_SIZES[parts[1]];
    if (!size || !parts[2]) continue;
    properties.push({ name: parts[2], type: parts[1], offset, size });
    offset += size;
  }
  const stride = offset;
  const propertyMap = new Map(properties.map((property) => [property.name, property]));
  const getProperty = (name: string) => propertyMap.get(name);
  const xProperty = getProperty('x');
  const yProperty = getProperty('y');
  const zProperty = getProperty('z');
  if (!xProperty || !yProperty || !zProperty || !stride) throw new Error('PLY 缺少位置属性');

  const sampleStep = Math.max(1, Math.ceil(vertexCount / maxPoints));
  const pointCount = Math.ceil(vertexCount / sampleStep);
  const positions = new Float32Array(pointCount * 3);
  const colors = new Float32Array(pointCount * 3);
  const scales = new Float32Array(pointCount);
  const opacities = new Float32Array(pointCount);
  const dataOffset = dataLineEnd + 1;
  const view = new DataView(buffer, dataOffset);
  const ascii = format === 'ascii';
  const asciiValues = ascii ? new TextDecoder().decode(bytes.subarray(dataOffset)).trim().split(/\s+/) : [];
  const vertexValues = (vertexIndex: number) => {
    if (ascii) {
      const start = vertexIndex * properties.length;
      return properties.map((_, propertyIndex) => Number(asciiValues[start + propertyIndex]));
    }
    return properties.map((property) => readBinaryValue(view, vertexIndex * stride + property.offset, property.type, littleEndian));
  };
  const valueAt = (values: number[], name: string) => {
    const propertyIndex = properties.findIndex((property) => property.name === name);
    return propertyIndex < 0 ? undefined : values[propertyIndex];
  };

  let minX = Infinity; let minY = Infinity; let minZ = Infinity;
  let maxX = -Infinity; let maxY = -Infinity; let maxZ = -Infinity;
  let outputIndex = 0;
  for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += sampleStep) {
    const values = vertexValues(vertexIndex);
    const x = valueAt(values, 'x') ?? 0;
    const y = valueAt(values, 'y') ?? 0;
    const z = valueAt(values, 'z') ?? 0;
    positions[outputIndex * 3] = x;
    positions[outputIndex * 3 + 1] = y;
    positions[outputIndex * 3 + 2] = z;
    minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);

    const red = valueAt(values, 'red') ?? valueAt(values, 'diffuse_red');
    const green = valueAt(values, 'green') ?? valueAt(values, 'diffuse_green');
    const blue = valueAt(values, 'blue') ?? valueAt(values, 'diffuse_blue');
    const dcRed = valueAt(values, 'f_dc_0');
    const dcGreen = valueAt(values, 'f_dc_1');
    const dcBlue = valueAt(values, 'f_dc_2');
    if (red !== undefined && green !== undefined && blue !== undefined) {
      const divisor = Math.max(red, green, blue) > 1 ? 255 : 1;
      colors[outputIndex * 3] = clamp(red / divisor, 0, 1);
      colors[outputIndex * 3 + 1] = clamp(green / divisor, 0, 1);
      colors[outputIndex * 3 + 2] = clamp(blue / divisor, 0, 1);
    } else {
      colors[outputIndex * 3] = clamp((dcRed === undefined ? 0.35 : 0.5 + SH_C0 * dcRed), 0, 1);
      colors[outputIndex * 3 + 1] = clamp((dcGreen === undefined ? 0.8 : 0.5 + SH_C0 * dcGreen), 0, 1);
      colors[outputIndex * 3 + 2] = clamp((dcBlue === undefined ? 1 : 0.5 + SH_C0 * dcBlue), 0, 1);
    }
    const opacity = valueAt(values, 'opacity');
    opacities[outputIndex] = opacity === undefined ? 0.82 : clamp(sigmoid(opacity), 0.04, 1);
    const scaleValues = ['scale_0', 'scale_1', 'scale_2'].map((name) => valueAt(values, name));
    const validScales = scaleValues.filter((value): value is number => value !== undefined && Number.isFinite(value));
    scales[outputIndex] = validScales.length ? Math.max(0.0001, validScales.reduce((sum, value) => sum + Math.exp(value), 0) / validScales.length) : 0.01;
    outputIndex += 1;
  }

  const center: [number, number, number] = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
  const radius = Math.max(0.001, Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2);
  for (let index = 0; index < pointCount; index += 1) {
    positions[index * 3] = (positions[index * 3] - center[0]) / radius;
    positions[index * 3 + 1] = (positions[index * 3 + 1] - center[1]) / radius;
    positions[index * 3 + 2] = (positions[index * 3 + 2] - center[2]) / radius;
    scales[index] = clamp(scales[index] / radius, 0.001, 0.18);
  }
  return { positions, colors, scales, opacities, center: [0, 0, 0], radius: 1 };
}

function normalize(vector: [number, number, number]): [number, number, number] {
  const length = Math.hypot(...vector) || 1;
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}
function cross(a: [number, number, number], b: [number, number, number]): [number, number, number] { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function dot(a: [number, number, number], b: [number, number, number]) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function lookAt(eye: [number, number, number]): Float32Array {
  const z = normalize(eye); const x = normalize(cross([0, 1, 0], z)); const y = cross(z, x);
  return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
}
function perspective(aspect: number): Float32Array {
  const f = 1 / Math.tan(Math.PI / 7.2); const near = 0.05; const far = 20;
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0]);
}

const VERTEX_SHADER = `#version 300 es
in vec3 a_position; in vec3 a_color; in float a_scale; in float a_opacity;
uniform mat4 u_view; uniform mat4 u_projection; uniform float u_point_scale;
out vec3 v_color; out float v_opacity;
void main() { vec4 view_position = u_view * vec4(a_position, 1.0); gl_Position = u_projection * view_position; gl_PointSize = clamp(u_point_scale * a_scale / max(0.1, -view_position.z), 1.0, 64.0); v_color = a_color; v_opacity = a_opacity; }`;
const FRAGMENT_SHADER = `#version 300 es
precision highp float; in vec3 v_color; in float v_opacity; out vec4 out_color;
void main() { vec2 point = gl_PointCoord * 2.0 - 1.0; float distance = dot(point, point); if (distance > 1.0) discard; float alpha = exp(-2.6 * distance) * v_opacity; if (alpha < 0.01) discard; out_color = vec4(v_color, alpha); }`;

function compileShader(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('无法创建 WebGL shader');
  gl.shaderSource(shader, source); gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'WebGL shader 编译失败');
  return shader;
}

function createProgram(gl: WebGL2RenderingContext) {
  const program = gl.createProgram();
  if (!program) throw new Error('无法创建 WebGL program');
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'WebGL program 链接失败');
  return program;
}

export function PlyPreview({ modelUrl, modelName, compact = false }: { modelUrl?: string; modelName: string; compact?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !modelUrl) { setState('error'); setError('没有可用的 PLY 资产'); return undefined; }
    let cancelled = false;
    let cleanup = () => undefined;
    setState('loading'); setError('');
    void fetch(modelUrl, { cache: 'no-store' }).then((response) => {
      if (!response.ok) throw new Error(`PLY 下载失败（${response.status}）`);
      return response.arrayBuffer();
    }).then((buffer) => {
      if (cancelled) return;
      const cloud = parsePly(buffer, compact ? 65000 : 220000);
      const gl = canvas.getContext('webgl2', { alpha: false, antialias: false });
      if (!gl) throw new Error('浏览器不支持 WebGL2');
      const program = createProgram(gl);
      const buffers = [cloud.positions, cloud.colors, cloud.scales, cloud.opacities].map((data) => {
        const bufferObject = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, bufferObject); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); return bufferObject;
      });
      const attributes = ['a_position', 'a_color', 'a_scale', 'a_opacity'].map((name, index) => {
        const location = gl.getAttribLocation(program, name); gl.bindBuffer(gl.ARRAY_BUFFER, buffers[index]); gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, index === 0 || index === 1 ? 3 : 1, gl.FLOAT, false, 0, 0); return location;
      });
      const viewLocation = gl.getUniformLocation(program, 'u_view'); const projectionLocation = gl.getUniformLocation(program, 'u_projection'); const pointScaleLocation = gl.getUniformLocation(program, 'u_point_scale');
      let yaw = 0.45; let pitch = 0.12; let distance = 2.65; let dragging = false; let lastX = 0; let lastY = 0;
      const render = () => {
        const ratio = window.devicePixelRatio || 1; const width = Math.max(1, canvas.clientWidth); const height = Math.max(1, canvas.clientHeight);
        canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio); gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0.025, 0.067, 0.15, 1); gl.clear(gl.COLOR_BUFFER_BIT); gl.useProgram(program);
        const eye: [number, number, number] = [Math.sin(yaw) * Math.cos(pitch) * distance, Math.sin(pitch) * distance, Math.cos(yaw) * Math.cos(pitch) * distance];
        gl.uniformMatrix4fv(viewLocation, false, lookAt(eye)); gl.uniformMatrix4fv(projectionLocation, false, perspective(width / height)); gl.uniform1f(pointScaleLocation, canvas.height * 1.4);
        gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.disable(gl.DEPTH_TEST); gl.drawArrays(gl.POINTS, 0, cloud.positions.length / 3);
      };
      const resizeObserver = new ResizeObserver(render); resizeObserver.observe(canvas);
      const handlePointerDown = (event: PointerEvent) => { dragging = true; lastX = event.clientX; lastY = event.clientY; canvas.setPointerCapture(event.pointerId); };
      const handlePointerMove = (event: PointerEvent) => { if (!dragging) return; yaw += (event.clientX - lastX) * 0.008; pitch = clamp(pitch + (event.clientY - lastY) * 0.008, -1.25, 1.25); lastX = event.clientX; lastY = event.clientY; render(); };
      const handlePointerUp = () => { dragging = false; };
      const handleWheel = (event: WheelEvent) => { event.preventDefault(); distance = clamp(distance + event.deltaY * 0.002, 1.3, 6); render(); };
      canvas.addEventListener('pointerdown', handlePointerDown); canvas.addEventListener('pointermove', handlePointerMove); canvas.addEventListener('pointerup', handlePointerUp); canvas.addEventListener('pointercancel', handlePointerUp); canvas.addEventListener('wheel', handleWheel, { passive: false });
      attributes.forEach((location) => { if (location < 0) throw new Error('PLY 预览 shader 属性缺失'); });
      render(); setState('ready');
      cleanup = () => { resizeObserver.disconnect(); canvas.removeEventListener('pointerdown', handlePointerDown); canvas.removeEventListener('pointermove', handlePointerMove); canvas.removeEventListener('pointerup', handlePointerUp); canvas.removeEventListener('pointercancel', handlePointerUp); canvas.removeEventListener('wheel', handleWheel); buffers.forEach((bufferObject) => bufferObject && gl.deleteBuffer(bufferObject)); gl.deleteProgram(program); };
    }).catch((cause: unknown) => { if (!cancelled) { setState('error'); setError(cause instanceof Error ? cause.message : 'PLY 预览失败'); } });
    return () => { cancelled = true; cleanup(); };
  }, [compact, modelUrl]);

  return <div className="ply-preview"><canvas ref={canvasRef} className="model-canvas" aria-label={`${modelName} Gaussian PLY 模型预览`} />{state !== 'ready' && <div className="ply-preview-state"><strong>{state === 'loading' ? '正在读取真实 PLY…' : '无法预览 PLY'}</strong>{state === 'error' && <span>{error}</span>}</div>}{state === 'ready' && <span className="ply-preview-badge">真实 PLY · 拖拽旋转</span>}</div>;
}
