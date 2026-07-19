# OpenAI 图像生成（Image Generation）流式（SSE）能力调研

> 目的：为一个长耗时（5–15 分钟）生图功能实现 SSE 流式请求，避免连接超时。
> 调研日期：2026-07-19。
> 主要来源：
> - 官方 API 参考（生成）：https://developers.openai.com/api/reference/resources/images/methods/generate
> - 官方 API 参考（流式事件）：https://developers.openai.com/api/reference/resources/images/generation-streaming-events/
> - 官方 API 参考（编辑流式事件）：https://developers.openai.com/api/reference/resources/images/edit-streaming-events
> - 参考实现 codex `image_gen.py`：https://raw.githubusercontent.com/openai/codex/main/codex-rs/skills/src/assets/samples/imagegen/scripts/image_gen.py
> - 第三方镜像文档（字段对照，非权威）：https://zenmux.ai/docs/api/openai/image-generation-streaming-events.html
>
> 说明：凡标注 “未在文档中找到” 的点，官方文档未明确给出，不做臆测。

---

## 0. 一句话结论（TL;DR）

- 流式**支持**：仅 GPT image 系列模型（gpt-image-1 / gpt-image-1-mini / gpt-image-1.5 等）支持，请求体设 `"stream": true`。DALL·E 不支持流式。
- 流式事件类型（generations 端点）：`image_generation.partial_image`（中间预览）与 `image_generation.completed`（最终完成）。
- 图像数据字段：两种事件都用 **`b64_json`**（base64 编码的图片）。
- 判定完成：收到 `event: image_generation.completed` / `data` 中 `"type":"image_generation.completed"` 即为最终图；该事件同时携带 `usage` token 统计。取该事件的 `b64_json` 作为最终完整图。
- 这是“分阶段渲染的部分预览图”，**不是**逐 token 的增量流；每个 partial 事件的 `b64_json` 都是一张可独立渲染的完整（低清）图，`partial_image_index` 从 0 递增。

---

## 1. 端点、方法、请求头

- URL：`POST https://api.openai.com/v1/images/generations`
  - 图像编辑对应 `POST https://api.openai.com/v1/images/edits`（同样支持 `stream`，事件前缀为 `image_edit.*`，见第 6 节）。
- HTTP 方法：`POST`
- 必需请求头：
  - `Content-Type: application/json`
  - `Authorization: Bearer $OPENAI_API_KEY`
- 官方描述：该端点 “Creates an image given a prompt.”

---

## 2. 请求体参数（generations 端点）

| 参数 | 类型 | 说明 / 取值 |
|------|------|-------------|
| `prompt` | string，**必需** | 文本描述。最大长度：GPT image 模型 **32000** 字符；`dall-e-2` 1000 字符；`dall-e-3` 4000 字符。 |
| `model` | string | 可选值：`dall-e-2`、`dall-e-3`、`gpt-image-1`、`gpt-image-1-mini`、`gpt-image-1.5`。官方默认 `dall-e-2`（当使用任一 GPT-image 专属参数时会切到 GPT image）。文档 size 示例中还出现 `gpt-image-2` / `gpt-image-2-2026-04-21`。**注意：`gpt-image-2` 未在 model 枚举正文列出，仅出现在 size 示例中；能否直接作为 model 值传入未在文档中明确确认。** codex 参考脚本默认 `DEFAULT_MODEL = "gpt-image-2"` 且校验要求 `"gpt-image-"` 前缀，透明背景回退模型为 `gpt-image-1.5`。 |
| `n` | number | 生成数量，min 1 / max 10。`dall-e-3` 只支持 `n=1`。 |
| `size` | string | GPT 标准尺寸 `1024x1024`、`1536x1024`、`1024x1536`，以及 `auto`。`gpt-image-2` 支持任意 `宽x高`（宽高均需能被 16 整除，宽高比在 1:3 到 3:1 之间，最大 `3840x2160`，超过 `2560x1440` 为实验性）。`dall-e-2`：`256x256`/`512x512`/`1024x1024`；`dall-e-3`：`1024x1024`/`1792x1024`/`1024x1792`。 |
| `quality` | string | `auto`（默认），GPT：`high`/`medium`/`low`；`dall-e-3`：`hd`/`standard`；`dall-e-2`：仅 `standard`。 |
| `background` | string | `transparent` / `opaque` / `auto`（默认）。**仅 GPT image**。若 `transparent`，output_format 应为 `png` 或 `webp`。 |
| `output_format` | string | `png` / `jpeg` / `webp`。**仅 GPT image**。 |
| `output_compression` | number | 压缩级别 0–100（%），用于 GPT image 且格式为 `webp`/`jpeg`，默认 100。 |
| `moderation` | string | `low` / `auto`（默认）。**仅 GPT image**。 |
| `stream` | boolean | 是否流式。**默认 `false`**。**仅 GPT image**。设为 `true` 时以 SSE 返回。 |
| `partial_images` | number | 取值 **0–3**。流式时返回的中间预览图数量。官方原文：“The number of partial images to generate. This parameter is used for streaming responses that return partial images. Value must be between 0 and 3. When set to 0, the response will be a single image sent in one streaming event.”（**设为 0 时，只在一个流式事件里发送一张最终图，即没有中间预览**）。文档另有提示：最终图可能在所有 partial 完成前就到达，且更快的生成可能产出比请求更少的预览。 |
| `response_format` | string | `url` / `b64_json`，**仅 dall-e**（GPT image 始终返回 base64）。url 有效期 60 分钟。 |
| `style` | string | `vivid` / `natural`，仅 `dall-e-3`。 |
| `user` | string | 终端用户标识。 |

---

## 3. 流式（SSE）响应事件格式 —— 核心

`stream: true` 时，响应为 `text/event-stream`（SSE）。generations 端点定义了两种事件类型。

### 3.1 `image_generation.partial_image`（中间预览）

官方描述：“Emitted when a partial image is available during image generation streaming.”

字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | string | 固定为 `"image_generation.partial_image"` |
| `b64_json` | string | **承载图像数据**：base64 编码的部分图，可直接渲染。 |
| `partial_image_index` | number | **0-based** 的部分图索引（0,1,2,…），用于排序。 |
| `created_at` | number | 事件创建的 Unix 时间戳。 |
| `size` | enum | `1024x1024` / `1024x1536` / `1536x1024` / `auto` |
| `quality` | enum | `low` / `medium` / `high` / `auto` |
| `background` | enum | `transparent` / `opaque` / `auto` |
| `output_format` | enum | `png` / `webp` / `jpeg` |

示例 payload：

```json
{
  "type": "image_generation.partial_image",
  "b64_json": "...",
  "created_at": 1620000000,
  "size": "1024x1024",
  "quality": "high",
  "background": "transparent",
  "output_format": "png",
  "partial_image_index": 0
}
```

### 3.2 `image_generation.completed`（最终完成）

官方描述：“Emitted when image generation has completed and the final image is available.”

字段（与 partial 相同的核心字段，但把 `partial_image_index` 换成了 `usage`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | string | 固定为 `"image_generation.completed"` —— **用它判定“最终完成”** |
| `b64_json` | string | **最终完整图**的 base64 数据。 |
| `created_at` | number | Unix 时间戳。 |
| `size` | enum | 同上。 |
| `quality` | enum | 同上。 |
| `background` | enum | 同上。 |
| `output_format` | enum | 同上。 |
| `usage` | object | 仅 GPT image 模型，token 用量。子字段见下。 |

`usage` 子字段：
- `total_tokens` (number)：总 token 数。
- `input_tokens` (number)：输入 prompt 的 token 数（图片+文本）。
- `input_tokens_details` (object)：`{ image_tokens: number, text_tokens: number }`
- `output_tokens` (number)：输出图片的 image token 数。

> 注：`usage` 的 `output_tokens_details`（含 `image_tokens`/`text_tokens`）在非流式 `ImagesResponse.usage` 中出现，但在 `image_generation.completed` 事件示例 payload 中未列出该子对象 —— **completed 事件是否含 `output_tokens_details` 未在文档示例中确认**。

示例 payload：

```json
{
  "type": "image_generation.completed",
  "b64_json": "...",
  "created_at": 1620000000,
  "size": "1024x1024",
  "quality": "high",
  "background": "transparent",
  "output_format": "png",
  "usage": {
    "total_tokens": 100,
    "input_tokens": 50,
    "output_tokens": 50,
    "input_tokens_details": {
      "text_tokens": 10,
      "image_tokens": 40
    }
  }
}
```

### 3.3 完成判定 & 取最终图（实现要点）

- **完成判定**：解析每条 SSE 的 `data` JSON，当 `type === "image_generation.completed"` 时即为最终事件。
- **取最终图**：取该 `completed` 事件的 `b64_json`，`base64` 解码写文件即为最终完整图。
- partial 事件仅用于渐进渲染预览；**不要**把最后一个 partial 当最终图（清晰度更低，且文档提示最终图可能先于全部 partial 到达）。
- 若 `partial_images = 0`：不会有 partial 事件，只会收到一个（completed）事件里的单张图。

---

## 4. 完整流式请求示例（curl）

> 说明：以下 curl 为依据上述参数**自行构造**的示例（官方与参考脚本均未提供 raw curl 流式示例，见第 7 节）。关键点是 `--no-buffer` 关闭 curl 输出缓冲，`-N` 同义（禁用缓冲），以便实时看到 SSE。

```bash
curl -sS --no-buffer https://api.openai.com/v1/images/generations \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-image-1.5",
    "prompt": "A cute baby sea otter floating on its back",
    "n": 1,
    "size": "1024x1024",
    "quality": "high",
    "output_format": "png",
    "stream": true,
    "partial_images": 3
  }'
```

### 预期 SSE 事件序列示例（partial_images=3）

> 依据官方事件定义构造的**期望序列**（顺序/字段来自官方，具体二进制内容为占位）：

```
event: image_generation.partial_image
data: {"type":"image_generation.partial_image","b64_json":"<preview0>","created_at":1620000000,"size":"1024x1024","quality":"high","background":"auto","output_format":"png","partial_image_index":0}

event: image_generation.partial_image
data: {"type":"image_generation.partial_image","b64_json":"<preview1>","created_at":1620000005,"size":"1024x1024","quality":"high","background":"auto","output_format":"png","partial_image_index":1}

event: image_generation.partial_image
data: {"type":"image_generation.partial_image","b64_json":"<preview2>","created_at":1620000010,"size":"1024x1024","quality":"high","background":"auto","output_format":"png","partial_image_index":2}

event: image_generation.completed
data: {"type":"image_generation.completed","b64_json":"<final>","created_at":1620000030,"size":"1024x1024","quality":"high","background":"auto","output_format":"png","usage":{"total_tokens":100,"input_tokens":50,"output_tokens":50,"input_tokens_details":{"text_tokens":10,"image_tokens":40}}}
```

> 注意：`event:` 行是否始终由服务端发送（相对 `data` 中的 `type` 字段），**官方文档以 `event:`/`data:` 双行形式给出示例**。稳妥的做法是**以 `data` JSON 里的 `type` 字段为准**做分支判断，不要只依赖 `event:` 行。

---

## 5. 非流式响应结构（对照）

`stream` 缺省或 `false` 时，返回单个 `ImagesResponse` JSON 对象：

- `created` (number)：Unix 时间戳。
- `background`：`transparent` / `opaque`。
- `data` (array)：每个 Image 对象含 `b64_json`（GPT image 始终 base64）、`revised_prompt`（仅 dall-e-3）、`url`（仅 dall-e）。
- `output_format`、`quality`、`size`。
- `usage`（仅 GPT image）：`input_tokens`、`input_tokens_details`（`image_tokens`/`text_tokens`）、`output_tokens`、`total_tokens`、`output_tokens_details`（`image_tokens`/`text_tokens`）。

示例：

```json
{
  "created": 1713833628,
  "data": [{ "b64_json": "..." }],
  "usage": {
    "total_tokens": 100,
    "input_tokens": 50,
    "output_tokens": 50,
    "input_tokens_details": { "text_tokens": 10, "image_tokens": 40 }
  }
}
```

取图：`data[i].b64_json` → base64 解码写文件。

---

## 6. 图像编辑端点的流式（补充）

- 端点：`POST https://api.openai.com/v1/images/edits`，同样支持 `stream: true`。
- 事件类型（官方“Image edit streaming events”页）：`image_edit.partial_image` 与 `image_edit.completed`，字段结构与 generations 版对应一致（`b64_json` / `partial_image_index` / `usage` 等）。
- codex 参考脚本的 edit 额外参数：`input_fidelity`、`image`、可选 `mask`。

---

## 7. 参考实现 codex `image_gen.py` 的关键事实

- **不做流式**：脚本全程无 `stream=True`、无 `partial_images`、无 SSE 处理。它完全依赖官方 OpenAI Python SDK 的一次性调用：
  - 同步：`result = client.images.generate(**payload)`
  - 异步：`await client.images.generate(**payload)`
  - 编辑：`result = client.images.edit(**request)`
- 不直接构造 URL/verb/header，交给 SDK（`OpenAI()` / `AsyncOpenAI()`）。
- 默认模型 `DEFAULT_MODEL = "gpt-image-2"`，校验要求 `"gpt-image-"` 前缀；透明背景回退提示：“Use --model gpt-image-1.5 --background transparent --output-format png instead.”
- payload 装配后做空值过滤：`payload = {k: v for k, v in payload.items() if v is not None}`；generate 的键为 `model, prompt, n, size, quality, background, output_format, output_compression, moderation`。
- 取图：`images = [item.b64_json for item in result.data]`，写文件 `out_path.write_bytes(base64.b64decode(image_b64))`。
- **超时/keep-alive**：脚本未显式设置 HTTP 超时或 keep-alive，交给 SDK 默认值。它实现的是**应用层重试**：`_generate_one_with_retries` + `_is_transient_error`（判定限流/超时类错误）+ 退避 `sleep_s = min(60.0, 2.0**attempt)`，并在有 `retry_after` 时通过 `_extract_retry_after_seconds` 尊重服务端建议。

> 结论：参考脚本对本次“流式长耗时”需求**无直接可复用的流式代码**，只能借鉴其重试/退避与 `b64_json` 解码写盘方式。

---

## 8. 针对长耗时（5–15 分钟）请求的建议

官方图像文档与参考脚本对 keep-alive / 超时的**直接论述很少**（下列多为 SSE 通用工程实践，非官方图像页原文）：

- **用流式本身就是抗超时的主要手段**：`stream: true` + `partial_images >= 1`，服务端会持续下发 partial 事件，使连接上有稳定的数据流，避免中间层（LB/代理/网关）因“空闲无字节”而断开。设 `partial_images: 0` 时中途无预览、无数据流，长耗时更易被中间层判定空闲——**建议至少 1，长耗时用 3**。
- **客户端超时配置**：
  - curl：加 `--no-buffer`（或 `-N`）实时读流；`--max-time` 需设得足够大（≥ 900s），或不设、改用连接级 keepalive。
  - HTTP 客户端（如 Node undici/axios、Python httpx）：把 **read/response 超时**放宽到 ≥ 900s，或对流式连接禁用整体响应超时，仅保留 **socket idle 超时** 并靠 partial 事件刷新它。
  - 反向代理（Nginx 等）：关闭 `proxy_buffering`，放大 `proxy_read_timeout` ≥ 900s。
- **完成判定要用 `type === "image_generation.completed"`**，不要靠“连接关闭”推断成功，避免把中断误判为完成。
- **重试/退避**：参考 codex 做法，对瞬时错误（限流/超时）指数退避 `min(60, 2**attempt)` 并尊重 `retry_after`。
- **未在文档中找到**：OpenAI 图像文档未明确给出针对长耗时的官方 keep-alive/心跳事件、超时上限、或 SSE 断线续传（如 `Last-Event-ID`）机制的说明。是否有心跳/注释行 keep-alive（SSE `:` 注释）**未在官方图像页确认**。

---

## 9. 实现清单（可直接照做）

1. `POST /v1/images/generations`，头：`Authorization: Bearer ...`、`Content-Type: application/json`。
2. body：`model: "gpt-image-1.5"`（或所需 GPT image 模型）、`prompt`、`size`、`quality`、`output_format`、`stream: true`、`partial_images: 3`。
3. 以 SSE 逐事件读取；对每条 `data` 行做 `JSON.parse`。
4. `type === "image_generation.partial_image"` → 用 `b64_json` 渲染预览，`partial_image_index` 排序。
5. `type === "image_generation.completed"` → 用 `b64_json` 作为最终图，base64 解码保存；读取 `usage` 记账；结束。
6. 客户端/代理超时放宽到 ≥ 900s，关闭响应缓冲；瞬时错误按指数退避重试。
7. 安全：`Authorization` 用环境变量注入，勿硬编码/回显密钥。

---

## 10. 来源链接

- 生成端点参考：https://developers.openai.com/api/reference/resources/images/methods/generate
- 生成流式事件参考：https://developers.openai.com/api/reference/resources/images/generation-streaming-events/
- 编辑流式事件参考：https://developers.openai.com/api/reference/resources/images/edit-streaming-events
- codex image_gen.py：https://raw.githubusercontent.com/openai/codex/main/codex-rs/skills/src/assets/samples/imagegen/scripts/image_gen.py
- 第三方镜像（字段对照，非权威）：https://zenmux.ai/docs/api/openai/image-generation-streaming-events.html
- 背景说明（第三方博客）：https://www.aifreeapi.com/en/posts/openai-image-generation-api-streaming
