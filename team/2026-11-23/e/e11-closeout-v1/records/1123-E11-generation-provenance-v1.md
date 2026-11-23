# 来源与真实生成记录

## 旧Gift与无角色Moment

从仓库已交付文件取用，二进制Git blob按repository-sources.json校验。原始用户附件50/51另存。E12原说明声称Gift由50抠透明、Moment由51修复导出；本次未重做这些处理。原始工具／模型／模式／seed／精确生成日期／当次提交的提示词未留存于本次可读材料，不补造。
01-image-prompts-v5.md中存在贝壳Gift与无角色Moment提示词，题材对应但不能据此证明当时实际逐字执行。v8例子仅作为可复用模板，不当原日志。

## 书店Scene

原始55/56来自用户，模型、模式与原始调用参数未知。11/23本会话使用内置图片编辑工具分别清除左上角“AI生成”水印；工具实际模型版本未暴露。edit参考为原55/56，工具结果各1254×1254。编辑提示词：

外景：Edit this bookstore exterior image. Remove only the upper-left translucent 'AI生成' watermark, its rounded rectangle and ghosting. Seamlessly reconstruct the cream wall and horizontal architectural moldings beneath it. Preserve the entire original composition, square framing, book window, door, plants, sidewalk, original pixel illustration texture, lighting and colors. No new text, no watermark. Return one clean full image.

内景：Edit this bookstore interior image. Remove only the upper-left translucent 'AI生成' watermark and its rounded rectangle. Reconstruct the ceiling, diagonal wooden trim and light/shadow behind the watermark seamlessly. Preserve original square composition, all bookshelves, windows, chair, plant, spacious wooden floor, illustration/pixel texture, original color saturation and lighting. Do not redesign or add objects. No text or watermark anywhere. Return one clean full image.

两张随后均裁1254×1070+0+150，最近邻375×320，关闭抖动量化96色，最近邻750×640。并非模型直接输出精确750×640。foot外(370,550)、内(400,550)。编辑会引起局部像素变化，不宣称水印区域外逐字节不变。

## 新增有角色Moment

11/23本会话内置图片生成工具，具体模型版本与seed未暴露。输入是程序合成的批准r2默认S02/F01参考，无第三方角色图。原始生成提示词、修订提示词分别见同目录txt，实际原输出保留sources/attempt-01及02（文件名含moment-character）。
第一轮有三个多余注意力装饰射线及背景渐变，未作为最终样张。第二轮去射线、简化沙面；随后最近邻降至300×300、关闭抖动量化96色、最近邻放大1200×1200、移除Alpha，形成4px输出网格。无服务端调用、无真实用户经历、无C14执行证据。真实完整提示词与v8通用模板不是字节相同，均单独记录。

## 证据分级

尺寸／Alpha／文件哈希：脚本实测。画面内容：人工视觉复核。旧生图调用：未知。新工具调用：本会话真实执行。A批准：仅输入r2装配已批准，新Moment及v8模板待审。生产API、存储、预算、缓存、跨设备和失败兜底：本轮未验。
