# OpenAI 图像编辑（Image Edit / img2img）流式（SSE）能力调研

> 目的：为一个长耗时（5–15 分钟）的图生图（带参考图）功能实现 SSE 流式 multipart 请求，防止 HTTP 超时。本文档记录 `POST /v1/images/edits` 端点的流式行为、multipart 字段、SSE 事件格式与实现依据。
>
> 调研日期：2026-07-19
>
> 主要来源：
> - [Create Image Edit（官方 API 参考）](https://developers.openai.com/api/reference/resources/images/methods/edit)
> - [Image edit streaming events（官方 SSE 事件参考）](https://developers.openai.com/api/reference/resources/images/edit-streaming-events)
> - [Image edit（TypeScript 示例页）](https://developers.openai.com/api/reference/typescript/resources/images/methods/edit/)
> - [Image generation streaming events（对照）](https://developers.openai.com/api/reference/resources/images/generation-streaming-events/)
> - 参考实现 codex `image_gen.py`（见下方“参考实现”一节）

---

## 0. 关键结论（TL;DR）

- **端点**：`POST https://api.openai.com/v1/images/edits`，`multipart/form-data`，`Authorization: Bearer $OPENAI_API_KEY`。
- **开启流式**：表单字段 `stream=true`；用 `partial_images`（0–3）控制中途推送几张部分图。`partial_images=0` 表示只在一个事件里发一张最终图。
- **edit 端点的 SSE 事件类型**（与 generation 端点前缀不同）：
  - `image_edit.partial_image` — 中途部分图
  - `image_edit.completed` — 最终完成（这是"最终完成"判定依据）
- **图像数据字段**：两类事件都用 **`b64_json`**（base64 编码的图像字节）。部分图事件额外带 **`partial_image_index`**（从 0 开始）；完成事件不带该字段，改带 **`usage`** 对象。
- **多参考图 `image[]`**：GPT image 模型最多 **16 张**；curl 用重复的 `-F "image[]=@file.png"`。SDK 里传数组给 `image` 参数。
- **mask**：单独的 `mask` 字段，PNG（带 alpha 通道）；透明区域表示要编辑的位置；多图时作用于第一张。

---

## 1. 端点、方法、请求头

| 项目 | 值 |
|------|-----|
| URL | `https://api.openai.com/v1/images/edits` |
| 方法 | `POST` |
| Content-Type | `multipart/form-data`（curl 用 `-F` 字段自动设置） |
| 认证 | `Authorization: Bearer $OPENAI_API_KEY` |

官方描述（原文）：
> "Creates an edited or extended image given one or more source images and a prompt. This endpoint supports GPT Image models (gpt-image-1.5, gpt-image-1, gpt-image-1-mini, and chatgpt-image-latest) and dall-e-2."

---

## 2. Multipart 表单字段（完整清单）

字段名以官方参考页为准。curl 里用 `-F "字段名=值"`；文件用 `-F "字段名=@路径"`。

| 字段 | 必填 | 类型 / 允许值 | 说明（含原文） |
|------|------|----------------|----------------|
| `prompt` | 是 | string，minLength 1，maxLength 32000（dall-e-2 为 1000） | "A text description of the desired image edit." |
| `image[]` | 是 | 文件 / 图片引用，数组 | "The image(s) to edit."。GPT image 模型：每张 `png`/`webp`/`jpg` < 50MB，**最多 16 张**。dall-e-2：单张方形 png < 4MB。curl 用重复的 `image[]=@filename`。 |
| `mask` | 否 | PNG 文件（带 alpha），< 4MB | "An additional image whose fully transparent areas ... indicate where `image` should be edited." 需与图片同尺寸；多图时应用于第一张。也可用 `{ image_url \| file_id }` 形式，"Provide exactly one of `image_url` or `file_id`." |
| `model` | 否 | `gpt-image-1.5` / `gpt-image-1` / `gpt-image-1-mini` / `chatgpt-image-latest` / `dall-e-2` | 默认 `gpt-image-1.5`。 |
| `background` | 否 | `transparent` / `opaque` / `auto`（默认 `auto`） | 仅支持透明背景的 GPT image 模型。 |
| `input_fidelity` | 否 | `high` / `low`（默认 `low`） | "Controls fidelity to the original input image(s)." 仅 gpt-image-1 与 gpt-image-1.5+；gpt-image-1-mini 不支持。 |
| `moderation` | 否 | `low` / `auto` | GPT image 模型的内容审核级别。 |
| `n` | 否 | integer，min 1，max 10 | 生成图片数量。 |
| `quality` | 否 | `low` / `medium` / `high` / `auto`（另有 `standard` 用于旧模型） | 默认 `auto`。 |
| `size` | 否 | `auto` / `1024x1024` / `1536x1024` / `1024x1536`（gpt-image-2 支持任意 16 整除的 `WxH`，比例 1:3–3:1，最大 `3840x2160`） | 图片尺寸。 |
| `output_format` | 否 | `png` / `jpeg` / `webp`（默认 `png`） | 仅 GPT image 模型。 |
| `output_compression` | 否 | integer 0–100（默认 100） | "Compression level for `jpeg` or `webp` output." |
| `stream` | 否 | boolean（默认 `false`） | "Stream partial image results as events." |
| `partial_images` | 否 | integer 0–3 | "The number of partial images to generate. This parameter is used for streaming responses that return partial images." 原文："When set to 0, the response will be a single image sent in one streaming event." |
| `user` | 否 | string | 终端用户标识。 |
| `response_format` | 否 | `url` / `b64_json` | 仅 dall-e-2 支持；"URLs are only valid for 60 minutes." GPT image 模型只返回 `b64_json`。 |

### 2.1 参考图 `image[]` 的多种传法

每个图片引用可用以下之一：

- **本地文件（multipart）**：curl `-F "image[]=@body-lotion.png"`，可重复多次。SDK 传数组给 `image`。
- **`file_id`**："The File API ID of an uploaded image to use as input."（先用 Files API 上传得到 ID）
- **`image_url`**："A fully qualified URL or base64-encoded data URL."（maxLength 20971520，约 20MB）——即可以是远程 URL，也可以是 `data:image/png;base64,....` 形式的 base64 data URL。

> 注：直接的 raw base64（非 data URL）通常通过 `image_url` 的 data URL 形式传入；纯文件字节则通过 multipart 文件上传。

### 2.2 mask 的传法

- multipart 文件：`-F "mask=@mask.png"`（PNG，带 alpha 通道；透明处 = 要编辑处）。
- 或对象形式：`{ "image_url": "..." }` 或 `{ "file_id": "..." }`，二选一。
- 参考实现 `image_gen.py` 中的告警原文："Mask should be a PNG with an alpha channel"，并检查 50MB 上限。

---

## 3. 流式（SSE）响应格式

设置 `stream=true` 后，响应为 `text/event-stream`。**edit 端点专属**两种事件类型（注意前缀是 `image_edit.`，与 generation 端点的 `image_generation.` 不同——见第 6 节）：

### 3.1 `image_edit.partial_image`（中途部分图）

> "Emitted when a partial image is available during image editing streaming."

字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | string 字面量 | `"image_edit.partial_image"` |
| `b64_json` | string | **base64 编码的部分图像数据（图像载荷字段）** |
| `partial_image_index` | number | **部分图的 0 基序号**（0, 1, 2, ...） |
| `background` | enum | `transparent` / `opaque` / `auto` |
| `created_at` | number | Unix 时间戳 |
| `output_format` | enum | `png` / `webp` / `jpeg` |
| `quality` | enum | `low` / `medium` / `high` / `auto` |
| `size` | enum | `1024x1024` / `1024x1536` / `1536x1024` / `auto` |

示例 payload：
```json
{
  "type": "image_edit.partial_image",
  "b64_json": "...",
  "created_at": 1620000000,
  "size": "1024x1024",
  "quality": "high",
  "background": "transparent",
  "output_format": "png",
  "partial_image_index": 0
}
```

### 3.2 `image_edit.completed`（最终完成）

> "Sent when editing finishes and the final image is ready."

字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | string 字面量 | `"image_edit.completed"` |
| `b64_json` | string | **base64 编码的最终图像数据（最终图像载荷字段）** |
| `background` | enum | `transparent` / `opaque` / `auto` |
| `created_at` | number | Unix 时间戳 |
| `output_format` | enum | `png` / `webp` / `jpeg` |
| `quality` | enum | `low` / `medium` / `high` / `auto` |
| `size` | enum | `1024x1024` / `1024x1536` / `1536x1024` / `auto` |
| `usage` | object | 仅 GPT image 模型返回，见下 |

`usage` 对象：
- `input_tokens`：number — "tokens (images and text) in the input prompt"
- `input_tokens_details`：object — `{ image_tokens: number, text_tokens: number }`
- `output_tokens`：number — 输出图像的 image tokens
- `total_tokens`：number — 总 tokens

示例 payload：
```json
{
  "type": "image_edit.completed",
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

### 3.3 两类事件的关键差异与"完成"判定

- 部分图事件带 `partial_image_index`、不带 `usage`；完成事件不带 `partial_image_index`、带 `usage`。
- **判定"最终完成"**：收到 `type == "image_edit.completed"` 的事件即为结束。
- **取最后一张完整图**：直接取 `image_edit.completed` 事件的 `b64_json` 并 base64 解码即可（这就是最终成品）。部分图仅用于渐进预览。

---

## 4. 完整示例

### 4.1 流式 multipart curl 请求（长耗时推荐）

```bash
curl -N --no-buffer \
  -X POST "https://api.openai.com/v1/images/edits" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -F "model=gpt-image-1.5" \
  -F "image[]=@body-lotion.png" \
  -F "image[]=@bath-bomb.png" \
  -F "image[]=@incense-kit.png" \
  -F "image[]=@soap.png" \
  -F "mask=@mask.png" \
  -F "input_fidelity=high" \
  -F "size=1024x1024" \
  -F "quality=high" \
  -F "output_format=png" \
  -F "stream=true" \
  -F "partial_images=3" \
  -F 'prompt=Create a lovely gift basket with these four items in it'
```

要点：
- `-N` / `--no-buffer`：禁用 curl 输出缓冲，让 SSE 事件实时到达（官方非流式示例基础上，流式变体"adds `-N` and `-F "stream=true"`"）。
- `image[]=@...` 可重复多次（最多 16 张）。
- `stream=true` + `partial_images=N`（0–3）开启渐进推送。

> 官方给出的非流式基准 curl（对照）：
> ```bash
> curl -s -D >(grep -i x-request-id >&2) \
>   -o >(jq -r '.data[0].b64_json' | base64 --decode > gift-basket.png) \
>   -X POST "https://api.openai.com/v1/images/edits" \
>   -H "Authorization: Bearer $OPENAI_API_KEY" \
>   -F "model=gpt-image-1.5" \
>   -F "image[]=@body-lotion.png" \
>   -F "image[]=@bath-bomb.png" \
>   -F "image[]=@incense-kit.png" \
>   -F "image[]=@soap.png" \
>   -F 'prompt=Create a lovely gift basket with these four items in it'
> ```

### 4.2 流式响应事件序列示例

设 `partial_images=2` 时，可能的事件流（`data:` 行为单行 JSON）：

```
event: image_edit.partial_image
data: {"type":"image_edit.partial_image","b64_json":"<...b64...>","created_at":1620000000,"size":"1024x1024","quality":"high","background":"auto","output_format":"png","partial_image_index":0}

event: image_edit.partial_image
data: {"type":"image_edit.partial_image","b64_json":"<...b64...>","created_at":1620000005,"size":"1024x1024","quality":"high","background":"auto","output_format":"png","partial_image_index":1}

event: image_edit.completed
data: {"type":"image_edit.completed","b64_json":"<...final b64...>","created_at":1620000030,"size":"1024x1024","quality":"high","background":"auto","output_format":"png","usage":{"total_tokens":100,"input_tokens":50,"output_tokens":50,"input_tokens_details":{"text_tokens":10,"image_tokens":40}}}
```

> 注：SSE 是否同时输出 `event:` 行取决于服务端；稳妥做法是**只解析 `data:` 行的 JSON，按 JSON 里的 `type` 字段分派**，不要依赖 `event:` 行。（这是通用 SSE 最佳实践；官方参考页主要以 JSON payload 形式给出事件，未强制说明 `event:` 行格式——见"未找到"标注。）

### 4.3 TypeScript SDK 流式示例（官方页原文）

```typescript
import fs from "fs";
import OpenAI, { toFile } from "openai";

const client = new OpenAI();

const imageFiles = [
    "bath-bomb.png",
    "body-lotion.png",
    "incense-kit.png",
    "soap.png",
];

const images = await Promise.all(
    imageFiles.map(async (file) =>
        await toFile(fs.createReadStream(file), null, { type: "image/png" })
    ),
);

const stream = await client.images.edit({
    model: "gpt-image-1.5",
    image: images,                 // 多参考图 = 传数组
    prompt: "Create a lovely gift basket with these four items in it",
    stream: true,
    // partial_images: 3,          // 可选，0–3
    // mask: await toFile(...),    // 可选
});

for await (const event of stream) {
    // event.type === "image_edit.partial_image" | "image_edit.completed"
    // event.b64_json 承载图像；partial 事件还带 event.partial_image_index
    console.log(event.type);
}
```

---

## 5. 非流式响应结构（对照）

`stream` 缺省/为 false 时，返回一个 `ImagesResponse` JSON 对象：

```jsonc
{
  "created": 1620000000,          // unix 时间
  "background": "auto",           // 可选
  "data": [
    {
      "b64_json": "<...b64...>",  // GPT image 模型返回；base64 图像
      "revised_prompt": "...",    // 可选
      "url": "..."                // 仅 dall-e-2/dall-e-3 返回；GPT image 不支持 url
    }
  ],
  "output_format": "png",
  "quality": "high",
  "size": "1024x1024",
  "usage": {                      // 仅 GPT-image-1 系列
    "input_tokens": 50,
    "input_tokens_details": { "image_tokens": 40, "text_tokens": 10 },
    "output_tokens": 50,
    "total_tokens": 100,
    "output_tokens_details": { }
  }
}
```

- 取图：`data[0].b64_json` → base64 解码。
- GPT image 模型**不返回 `url`**，只有 `b64_json`。

---

## 6. edit 端点 vs generation 端点：流式差异

| 维度 | edit（`/v1/images/edits`） | generation（`/v1/images/generations`） |
|------|-----------------------------|------------------------------------------|
| 部分图事件名 | `image_edit.partial_image` | `image_generation.partial_image` |
| 完成事件名 | `image_edit.completed` | `image_generation.completed` |
| 图像数据字段 | `b64_json` | `b64_json` |
| 部分图序号字段 | `partial_image_index` | `partial_image_index` |
| `stream` / `partial_images` | 支持（0–3） | 支持（0–3） |
| 事件字段结构 | 同（type/b64_json/created_at/size/quality/background/output_format，completed 带 usage） | 同 |

**核心差异**：仅事件类型名前缀不同（`image_edit.` vs `image_generation.`）。字段结构、`partial_images` 语义、`b64_json` 载荷方式一致。实现时按 `type` 前缀区分即可，或直接对两种前缀都做兼容匹配。generation 端点确认使用 `{"type":"...partial_image","b64_json":"...","partial_image_index":0}` 结构（来源：generation TypeScript 参考页片段），与 edit 对齐。

---

## 7. 长耗时请求（5–15 分钟）实现建议

来自文档/参考代码可确认的点，以及基于 SSE 通用实践的建议（后者已标注）：

1. **优先使用流式**：`stream=true` + `partial_images >= 1`。持续到达的 `image_edit.partial_image` 事件本身就是"应用层 keep-alive"——只要有字节流动，中间代理/负载均衡就不易因空闲而断连。这是防 5–15 分钟超时的主要手段。
2. **客户端禁用缓冲**：curl 用 `-N`/`--no-buffer`；Node/fetch 侧要以流方式逐块读取，不要等 body 读完。
3. **超时设置**：把 HTTP 客户端的**响应/空闲超时**放宽到 > 15 分钟（如 900–1200s），或依赖"收到任意事件即重置空闲计时"的机制。连接建立超时可保持较短。
4. **反向代理**：若前面有 Nginx/网关，需关闭对该路由的响应缓冲（如 Nginx `proxy_buffering off;`、`proxy_read_timeout`/`proxy_send_timeout` 调大），并确保支持 `text/event-stream` 透传。
5. **完成判定**：收到 `image_edit.completed` 才算成功，取其 `b64_json` 为最终图；此前的 partial 仅作预览/进度。
6. **错误/断连**：SSE 断连后需重试整个请求（图像 edit 无官方续传/`Last-Event-ID` 机制——见"未找到"标注）。建议对整次请求做幂等重试与用户可见的进度反馈。

### 明确"未在文档中找到"的点

- **`event:` 行的确切文本格式**：官方参考页以事件 JSON payload 形式描述，未明确规定 SSE `event:` 行是否存在及其确切拼写。→ 实现时以解析 `data:` JSON 的 `type` 字段为准。
- **官方 keep-alive 心跳/注释行（`: keep-alive`）**：文档未提及 edit 流是否发送 SSE 注释心跳。→ 不要依赖心跳，依赖 partial 事件流动。
- **断线续传 / `Last-Event-ID`**：文档未提供图像 edit 流的续传机制。→ 断连按整次重试处理。
- **HTTP keep-alive / 具体超时数值上限**：官方文档未给出针对 edit 端点的明确超时数值或 keep-alive 头建议；上面的超时数值为工程建议，非文档原文。
- **参考实现 `image_gen.py` 不涉及流式**：该脚本用 OpenAI Python SDK 的同步调用 `client.images.edit(**request)`，从 `result.data` 读 `b64_json`，**没有 `stream`/`partial_images` 参数、没有 SSE 解析**。它对本任务的价值在于 edit 请求的字段构造（见第 8 节），而非流式。

---

## 8. 参考实现 `image_gen.py` 的可复用要点（非流式）

来源：codex `codex-rs/skills/src/assets/samples/imagegen/scripts/image_gen.py`。它通过 OpenAI Python SDK 发请求，关键片段：

- 多图：`--image` 用 `action="append"` 收集多路径；通过 `_FileBundle` 打开文件后
  ```python
  request["image"] = image_files if len(image_files) > 1 else image_files[0]
  ```
- mask：仅在存在时加入，且校验 PNG/50MB：
  ```python
  if mask_file is not None:
      request["mask"] = mask_file
  ```
  告警文案："Mask should be a PNG with an alpha channel"。
- `input_fidelity`：edit 专属，校验 `{"low", "high", None}`；对 gpt-image-2 拒绝（该模型图像输入"always use high fidelity"）。
- 调用与取图：
  ```python
  result = client.images.edit(**request)
  images = [item.b64_json for item in result.data]
  ```
- 认证：依赖环境变量 `OPENAI_API_KEY`（`_ensure_api_key`）。
- 该脚本 dry-run 里打印的 `"/v1/images/edits"` 仅为预览标签，实际由 SDK 内部构造 URL/headers/multipart。

---

## 9. 来源链接

- [Create Image Edit — 官方 API 参考](https://developers.openai.com/api/reference/resources/images/methods/edit)
- [Image edit streaming events — 官方 SSE 事件参考](https://developers.openai.com/api/reference/resources/images/edit-streaming-events)
- [Image edit — TypeScript 示例页](https://developers.openai.com/api/reference/typescript/resources/images/methods/edit/)
- [Image generation streaming events — 对照](https://developers.openai.com/api/reference/resources/images/generation-streaming-events/)
- [Image generation — TypeScript 参考（含 partial_image payload 片段）](https://developers.openai.com/api/reference/typescript/resources/images/methods/generate/)
- 参考实现：`https://raw.githubusercontent.com/openai/codex/main/codex-rs/skills/src/assets/samples/imagegen/scripts/image_gen.py`
