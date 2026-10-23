# 雨课堂（www.yuketang.cn）学习进度协议逆向记录

全部结论来自本机抓包 + 重放验证。账号：`张三 / 20250001 / uid 40000001`（platform_id=3 下 `user_id=40000002`）。

## 1. 关键标识

| 名称 | 值 | 来源 |
|---|---|---|
| `classroom_id` | 10000001 | 课程 URL |
| `course_id` (`cid`) | 2000001 | `chapter` 接口 |
| `sku_id` | 3000001 | 学习日志 / `late_submission_leaf` |
| `sign` | `Xy9KpQ2mR4t` | 播放页 URL 路径 `/pro/lms/{sign}/{cid}/` |
| `university_id` / `uv_id` | 2910 | URL + localStorage |
| `platform_id` | 3（高校版） | URL |
| 主站 `user.id` | 40000001 | `/api/v3/user/basic-info` |
| LMS `user_id` | 40000002 | 心跳 body 的 `u`、track 的 `distinct_id` |
| `cc`（客户端标识） | `0123456789ABCDEF0123456789ABCDEF` | 心跳 body，疑似设备/会话指纹 |

## 2. 必带请求头

```
xtbz: ykt                     # 缺了返回 {"msg":"XTBZ IS REQUIRED","error_code":40000}
cookie: sessionid=...; csrftoken=...; uv_id=2910; university_id=2910; platform_id=3
referer: https://www.yuketang.cn/ai-workspace/lms-graph/{classroom_id}/video/{leaf_id}
```

`xtbz` 只认 `ykt`。填 `xt` / `yuketang` / `1` 会返回 `80019 请购买该课程之后再学习`。

## 3. 接口清单

### 章节树
```
GET /mooc-api/v1/lms/learn/course/chapter?cid={cid}&sign={sign}&term=latest&uv_id=2910&classroom_id={room}
```
返回 `data.course_chapter[].section_leaf_list[].leaf_list[]`，节点字段：`id`(leaf_id)、`leaf_type`、`is_locked`、`is_show`。`leaf_type`：0=视频内容、3=作业、4=考试。

### 单节信息
```
GET /mooc-api/v1/lms/learn/leaf_info/{classroom_id}/{leaf_id}/?classroom_id={room}
```

### 播放页（真实入口）
```
https://www.yuketang.cn/ai-workspace/lms-graph/{classroom_id}/video/{leaf_id}?is_chapter=1
```
从「学习日志」列表点条目会 **新开标签页**。视频是 `ali-cdn.xuetangx.com/*.mp4?auth_key=...` 直链。

### 进度查询 ← 判据都在这里
```
GET /video-log/get_video_watch_progress/?cid={cid}&user_id={uid_p3}&classroom_id={room}
    &video_type=video&vtype=rate&video_id={leaf_id}&snapshot=1&no_loading=true
```
返回：
```json
{"data":{"90000003":{
  "first_point": 1792759883.36,   // 首次观看时间戳
  "last_point": 350.0,            // 最后播放位置（秒）
  "completed": 0,                 // 是否完成 0/1
  "watch_length": 56,             // 累计有效观看秒数
  "ult": 1792759914.487,          // 最后更新时间戳
  "rate": 0.1404,                 // watch_length / video_length
  "video_length": 399.0           // 视频总长
}}}
```

### 心跳上报 ← 进度就靠它
```
POST /video-log/heartbeat/
{"heart_data":[ {事件}, {事件}, ... ]}
```
单事件结构（实测字段）：
```json
{
  "i": 5,                          // 固定
  "et": "heartbeat",               // 事件类型，见下
  "p": "web",                      // 平台
  "n": "ali-cdn.xuetangx.com",     // CDN 域名
  "lob": "ykt",
  "cp": 29.8,                      // currentTime，当前播放位置 ← 进度核心
  "fp": 0, "tp": 0,                // 前进/后退累计（未启用）
  "sp": 1,                         // 倍速
  "ts": "1792759914487",           // 毫秒时间戳（字符串）
  "u": 40000002,                   // LMS user_id
  "uip": "",
  "c": 2000001,                    // course_id
  "v": 90000003,                   // leaf_id / video_id
  "skuid": 3000001,
  "classroomid": 10000001,
  "cc": "0123456789ABCDEF0123456789ABCDEF",
  "d": 399.2,                      // 视频总时长
  "pg": "90000003_13bxa",          // 页面标识
  "sq": 14,                        // 包内自增序号
  "t": "video", "cards_id": 0, "slide": 0, "v_url": ""
}
```

真实播放时 `et` 序列：`loadstart → loadeddata → playing → waiting → playing → heartbeat(每5s) → ratechange`。心跳固定 5 秒一条，`cp` 同步递增。

### 埋点（无鉴权，但无意义）
```
POST /video-log/log/track/
```
只要 body 里有 `data` 和 `ts_ms` 就返回 `success`，**不做任何校验也不鉴权**。无 cookie 时记为匿名，对刷进度无用。

## 4. 核心结论：服务端把 `heart_data` 逐条信任

两个验证实验：

| 实验 | 操作 | 结果 |
|---|---|---|
| 单条跳跃 | 发 1 条 `cp=350`（真实播放才到 29.8） | `last_point` 29.8→**350.0**，`watch_length` 仅 +25 |
| 批量补发 | 一次 POST 80 条，`cp` 每步 +5s、`ts` 每步 +5000ms | `watch_length` 56→**401**，`rate`→**1**，`completed`→**1** |

即：

- `cp`（播放位置）**完全由客户端决定**，服务端照单全收；
- `watch_length` 按事件间的 `ts` 差值累加，只要伪造出连续的 `ts` 序列，就能一次性把累计时长堆满；
- `completed` 的判定条件是 `watch_length >= video_length`（实测 401/399 → 1）；
- `video_length` 不需要客户端提供——`d=0` 时服务端会自己探出来（实测 402s）。

## 5. 可用打法

1. `GET progress` 查是否已完成，已完成直接跳；
2. 未完成且无 `video_length` → 发 2 条探测心跳，回查拿时长；
3. 按 `need = ceil(video_length/5) + 12` 生成事件，`cp = k*5`、`ts = now + k*5000`；
4. 一次 POST 全部，2 秒后回查 `completed`；
5. 未达标则补发 60 条（`cp` 拉到 `video_length-0.3`）。

实测：85 个视频节点，单节耗时 2~4 秒，全部一次通过。

## 6. 风险点

- `cc` 是设备/会话指纹，换机器或重新登录可能变，变了要先从播放页重新抓一次；
- `sq`、`ts` 单调递增是唯一像样的校验，别让 `ts` 倒退；
- `watch_length` 单次涨幅过大是否触发人工复核，未知——本方案按「连续 5 秒一步」的节奏伪造，与真实播放的流量形状一致；
- `get_video_watch_progress` 的 `rate` 上限就是 1，超过 `video_length` 无意义。
